const crypto = require('crypto');

/* FIXME probably want to be able to override this at some point, but config
 * file stuff sucks to implement... maybe I'd like to put it in package.json,
 * like Babel does, but their .babelrc/package.json solution is homegrown and
 * not reusable (see:
 * babel-core/lib/transformation/file/options/build-config-chain.js) */
const options = {
	translation_tag: "T",
	//translation_fn: "_", /* TODO gettext-style, but with deps-support? */
}

class TraksError extends Error {
	constructor(filename, loc, msg) {
		if (!loc) loc = {start: "???"};
		super(`at ${filename}:${loc.start.line}: ${msg}`);
		this.filename = filename;
		this.loc = loc;
		this.msg = msg;
	}
}

const is_translation_tag_node = (node) => {
	return node.type === "JSXElement" && node.openingElement.name.name === options.translation_tag;
};

const get_filename = (path) => {
	return path.hub.file.opts.filename;
}

const assert_non_nested_translation_path = (path) => {
	var n = path.parent;
	while (n) {
		if (is_translation_tag_node(n)) {
			const T = options.translation_tag;
			throw new TraksError(
				get_filename(path),
				path.node.loc,
				"translation <"+T+">-tags cannot be nested")
		}
		n = n.parent;
	}
}

const is_react_component_name = (name) => name[0] === name[0].toUpperCase();

const process_path = (path) => {
	const node = path.node;

	if (!is_translation_tag_node(path.node)) throw new Error("expected translation tag node");
	assert_non_nested_translation_path(path);

	const code = path.hub.file.code;
	const body = code.slice(node.openingElement.end, node.closingElement.start)

	var deps = [];
	var context = "";

	/* parse translation tag attributes */
	for (const attr of path.node.openingElement.attributes) {
		const name = attr.name.name;
		switch (name) {
		case "deps": {
			/* allow injection of extra dependencies, if
			 * somehow it doesn't make sense to have them
			 * inside the <T> tag, e.g.:
			 *    <T deps={[count]}>You have unread messages</T>
			 * which could translate to:
			 *  - You have no unread messages
			 *  - You have one unread message
			 *  - You have unread messages
			 * or something... I'd probably prefer
			 *   <T>You have {count} unread messages</T>
			 * which would add the same dependency...  but
			 * here's some rope to shoot yourself in the
			 * foot with if you really want it! */
			const value = attr.value;
			if (value.type !== "JSXExpressionContainer") {
				throw new TraksError(get_filename(path), value.loc, "expected jsx expression for 'deps' attribute");
			}
			if (value.expression.type !== "ArrayExpression") {
				throw new TraksError(get_filename(path), value.expression.loc, "expected jsx expression containing array for 'deps' attribute");
			}
			for (const e of value.expression.elements) {
				if (e.type !== "Identifier") {
					throw new TraksError(get_filename(path), e.loc, `expected Identifier in 'deps' array, got ${e.type}`);
				}
				deps.push(e.name);
			}
			break;
		}
		case "context": {
			const value = attr.value;
			if (value.type !== "StringLiteral") {
				throw new TraksError(get_filename(path), value.loc, "expected string literal for 'context' attribute");
			}
			context = value.value;
			break;
		}
		case "key":
			// "key" is React specific
			break;
		default:
			/* disallow unknown attributes */
			throw new TraksError(get_filename(path), path.node.loc, `invalid attribute name: '${name}'`);
		}
	}

	/* find dependencies inside translation tag: these are:
	 *   - React-component names
	 *   - identifiers
	 * also, functions are disallowed because they complicate
	 * dependency analysis (you can always lift functions out of
	 * translation tags, which is totally fine) */
	const disallow_functions = (path) => {
		throw new TraksError(get_filename(path), path.node.loc, "translation tags cannot have inline functions");
	}
	for (const child of path.get("children")) {
		child.traverse({
			JSXIdentifier: (path) => {
				const name = path.node.name;
				if (!is_react_component_name(name)) return; // ignore html (non-react component) tags
				deps.push(name);
			},
			Identifier: (path) => {
				deps.push(path.node.name);
			},
			ArrowFunctionExpression: disallow_functions,
			FunctionExpression: disallow_functions,
		});
	}

	/* convert deps into ordered set */
	var dep_set = {};
	for (const dep of deps) dep_set[dep] = true;
	deps = Object.keys(dep_set);
	deps = deps.sort();

	/* remove leading/trailing whitespace and collapse whitespace sequences
	 * for the purpose of making a signature/key. there may be some really
	 * weird cases where this is the WrongThing(tm), but I can't think of
	 * any. indentation changes are way more common and shouldn't change
	 * the signature. */
	const signature_body = body.replace(/^[ \t]+/gm, '').replace(/[ \t]+$/gm, '').replace(/[ \t]+/g, ' ');

	/* calculate signature, and a body from it */
	const signature = signature_body + "\x00" + context + "\x00" + deps.join(",");
	const key = crypto.createHash('sha256').update(signature).digest('hex').slice(0, 12);

	const loc = node.loc;

	var is_multiline = false;
	var lines = [];
	if (loc.end.line > loc.start.line) {
		is_multiline = true;
		var i;
		for (i = node.openingElement.start - 1; i >= 0; i--) {
			const ch = code[i];
			if (ch === "\n") {
				i++;
				break;
			}
		}

		var pre = '';
		for (; i < node.openingElement.start; i++) {
			const ch = code[i];
			if (ch === ' '  || ch === '\t') {
				pre += ch;
			} else {
				break;
			}
		}

		for (var line of body.split("\n")) {
			if (line.slice(0, pre.length) === pre) {
				line = line.slice(pre.length);
			}
			lines.push(line);
		}
	} else {
		lines.push(body);
	}

	return {
		signature,
		key,
		deps,
		body,
		is_multiline,
		lines,
		context,
		loc,
	};
};

const replace = (babel, path, keep_children) => {
	if (path.node.was_traksed) return; // prevent infinite recursion...
	const t = babel.types;
	const { key, deps } = process_path(path);
	const JT = t.jSXIdentifier(options.translation_tag);
	const is_self_closing = !keep_children;
	const children = keep_children ? path.node.children : [];

	var attributes = [
		t.jSXAttribute(t.jSXIdentifier("k"), t.stringLiteral(key)),
		t.jSXAttribute(t.jSXIdentifier("deps"), t.jSXExpressionContainer(t.arrayExpression(
			deps.map(dep => t.identifier(dep))
		))),
	];

	/* preserve "key" attribute (it's React-specific) */
	for (const attr of path.node.openingElement.attributes) {
		const name = attr.name.name;
		if (name === "key") {
			attributes.push(attr);
			break;
		}
	}

	var element = t.jSXElement(
		t.jSXOpeningElement(JT, attributes, is_self_closing),
		t.JSXClosingElement(JT),
		children,
		is_self_closing
	);
	element.was_traksed = true;
	path.replaceWith(element);
};

module.exports = { TraksError, is_translation_tag_node, process_path, replace, options }

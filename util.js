const crypto = require('crypto');
const fs = require('fs');

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

const capture_dependencies = (root_path, deps) => {
	const disallow_functions = (path) => {
		throw new TraksError(get_filename(path), path.node.loc, "translation tags cannot have inline functions");
	}
	root_path.traverse({
		JSXIdentifier: (path) => {
			const name = path.node.name;
			if (!is_react_component_name(name)) return; // ignore html (non-react component) tags
			deps.push(name);
		},
		Identifier: (path) => {
			const p = path.parent;
			if (p && p.type === 'MemberExpression') {
				if (path.node === p.object) {
					deps.push(path.node.name);
				}
			} else if (p && p.type === 'ObjectProperty') {
				if (path.node === p.value) {
					deps.push(path.node.name);
				}
			} else {
				deps.push(path.node.name);
			}
		},
		ThisExpression: (path) => {
			throw path.buildCodeFrameError("'this' is not allowed within <T>-tags");
		},
		ArrowFunctionExpression: disallow_functions,
		FunctionExpression: disallow_functions,
	});
}

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
	for (const child of path.get("children")) {
		capture_dependencies(child, deps);
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

function get_key_deps_attributes(t, key, deps) {
	return [
		t.jSXAttribute(t.jSXIdentifier("k"), t.stringLiteral(key)),
		t.jSXAttribute(t.jSXIdentifier("deps"), t.jSXExpressionContainer(t.arrayExpression(
			deps.map(dep => t.identifier(dep))
		))),
	];
}

function patch_key_attr(attributes, path) {
	/* preserve "key" attribute (it's React-specific) */
	for (const attr of path.node.openingElement.attributes) {
		const name = attr.name.name;
		if (name === "key") {
			attributes.push(attr);
			break;
		}
	}
	return attributes;
}

const replace = (babel, path, keep_children) => {
	if (path.node.was_traksed) return; // prevent infinite recursion...
	const t = babel.types;
	const { key, deps } = process_path(path);
	const JT = t.jSXIdentifier(options.translation_tag);
	const is_self_closing = !keep_children;
	const children = keep_children ? path.node.children : [];

	var attributes = get_key_deps_attributes(t, key, deps);

	attributes = patch_key_attr(attributes, path);

	var element = t.jSXElement(
		t.jSXOpeningElement(JT, attributes, is_self_closing),
		t.JSXClosingElement(JT),
		children,
		is_self_closing
	);
	element.was_traksed = true;
	path.replaceWith(element);
};

const bake = (babel, path, translations, lang) => {
	if (path.node.was_traksed) return; // prevent infinite recursion...
	const t = babel.types;
	const { key, deps } = process_path(path);

	var node = translations.lookup(key, lang);
	if (!node) throw path.buildCodeFrameError("translation not found: lookup(" + JSON.stringify(key) + ", " + JSON.stringify(lang) + ") failed");

	var children;
	var attributes;
	if (translations.can_inline(key, lang)) {
		children = node.children;
		attributes = [];
	} else {
		children = [];
		attributes = get_key_deps_attributes(t, key, deps);
	}

	attributes = patch_key_attr(attributes, path);

	const JT = t.jSXIdentifier(options.translation_tag);
	const is_self_closing = false;

	var element = t.jSXElement(
		t.jSXOpeningElement(JT, attributes, is_self_closing),
		t.JSXClosingElement(JT),
		children,
		is_self_closing
	);
	element.was_traksed = true;
	path.replaceWith(element);
};

const assert_type = (node, type) => {
	if (node.type !== type) {
		const at = ":" + node.loc.start.line;
		const reason = "expected " + type + "; got " + node.type;
		throw path.buildCodeFrameError("corrupt translations file at " + at + ": " + reason);
	}
};

const unpack_translation_function = (path) => {
	const node = path.node

	var captured_deps = [];
	var dep_set = {};
	for (const param of node.params) {
		assert_type(param, "Identifier");
		captured_deps.push(param.name);
		dep_set[param.name] = true;
	}

	var can_inline;

	const btype = node.body.type;
	if (btype === "BlockStatement") {
		can_inline = false;
	} else {
		var body_deps = [];
		for (const child of path.get("body").get("children")) {
			capture_dependencies(child, body_deps);
		}
		can_inline = true;
		for (const dep of body_deps) {
			if (dep_set[dep]) continue;
			can_inline = false;
			break;
		}
	}

	var fn_type, fn_node;
	if (can_inline) {
		fn_type = "expression";
		fn_node = node.body;
	} else {
		fn_type = "block";
		fn_node = node;
	}

	return {
		captured_deps: captured_deps,
		can_inline: can_inline,
		fn_type: fn_type,
		fn_node: fn_node,
	};
};

const bake_translations_export = (babel, path, lang) => {
	if (path.node.was_traksed) return; // prevent infinite recursion...
	const t = babel.types;
	const decl_path = path.get('declaration');

	var new_properties = [];
	assert_type(decl_path.node, "ObjectExpression");
	for (const prop_path of decl_path.get('properties')) {
		const prop = prop_path.node;
		assert_type(prop, "ObjectProperty");
		assert_type(prop.key, "StringLiteral");
		assert_type(prop.value, "ObjectExpression");
		const key = prop.key.value;
		for(const epath of prop_path.get('value').get('properties')) {
			const e = epath.node;
			assert_type(e, "ObjectProperty");
			assert_type(e.key, "StringLiteral");
			const target = e.key.value;
			if (target !== lang) continue;
			assert_type(e.value, "ArrowFunctionExpression");

			const unpack = unpack_translation_function(epath.get('value'));
			if (!unpack.can_inline) {
				new_properties.push(t.objectProperty(
					t.stringLiteral(key),
					e.value
				));
			}
		}
	}

	var element = t.exportDefaultDeclaration(t.objectExpression(new_properties));
	element.was_traksed = true;
	path.replaceWith(element);
};

class Translations {
	constructor(babel, babel_plugins, translations_path, metadata_path) {
		this.seen_src_tags_map = {};
		this.all_refs = [];
		this.known_keys = {};
		this.node_map = {};
		this.can_inline_map = {};

		this.translations_path = translations_path;

		if (metadata_path) {
			this.metadata_path = metadata_path;
			this.metadata = JSON.parse(fs.readFileSync(this.metadata_path));
		}
		this.parse_translations_file(babel, babel_plugins);
	}

	parse_translations_file(babel, babel_plugins) {
		var export_path;
		const code = fs.readFileSync(this.translations_path).toString();
		const tx = babel.transform(code, {
			filename: this.translations_path,
			babelrc: false,
			plugins: [
				babel_plugins,
				function (babel) {
					return {
						visitor: {
							ExportDefaultDeclaration(path) {
								export_path = path;
							}
						}
					};
				}
			]
		});

		if (!export_path) corrupt(null, "found no default export");

		const declaration_path = export_path.get('declaration');
		const declaration = declaration_path.node;
		assert_type(declaration, "ObjectExpression");

		var translation_list = [];
		for (const key_prop_path of declaration_path.get("properties")) {
			const key_prop = key_prop_path.node;
			assert_type(key_prop, "ObjectProperty");
			assert_type(key_prop.key, "StringLiteral");
			const key = key_prop.key.value;
			this.known_keys[key] = true;
			const body_path = key_prop_path.get("value");
			assert_type(body_path.node, "ObjectExpression");

			var deps = null;
			var dep_set = {};
			var is_new = false;
			var is_deleted = false;
			var is_fuzzy = false;
			var context = "";
			var refs = [];
			var fn_bodies = [];
			var metadata_fields = [];
			this.node_map[key] = {}
			this.can_inline_map[key] = {}
			for (const target_prop_path of body_path.get("properties")) {
				const target_prop = target_prop_path.node;
				assert_type(target_prop, "ObjectProperty");
				assert_type(target_prop.key, "StringLiteral");
				const target = target_prop.key.value;
				const value_path = target_prop_path.get("value");
				const value = value_path.node;

				const chk_bool = (field) => {
					if (target !== field) return false;
					assert_type(value, "BooleanLiteral");
					if (!value.value) corrupt(value, "only 'true' is a valid value for " + field);
					return true;
				};

				if (target[0] === "#") {
					metadata_fields.push([target, code.slice(value.start, value.end)]);
				} else if (chk_bool("_new")) {
					is_new = true;
				} else if (chk_bool("_deleted")) {
					is_deleted = true;
				} else if (chk_bool("_fuzzy")) {
					is_fuzzy = true;
				} else if (target === "_context") {
					assert_type(value, "StringLiteral");
					context = value.value;
				} else if (target === "_refs") {
					assert_type(value, "ArrayExpression");
					for (const element of value.elements) {
						assert_type(element, "StringLiteral");
						const xs = element.value.split(":");
						if (xs.length !== 2) corrupt(element, "ref not on <path>:<line> form");
						const [path, line_str] = xs;
						const line = parseInt(line_str, 10);
						if (isNaN(line)) corrupt(element, "invalid line number in ref");
						const ref = [path, line];
						refs.push(ref);
						this.all_refs.push(ref);
					}
				} else {
					assert_type(value, "ArrowFunctionExpression");

					const unpack = unpack_translation_function(value_path);

					if (deps === null) {
						deps = unpack.captured_deps;
					} else {
						var match = true;
						if (deps.length !== unpack.captured_deps.length) {
							match = false;
						} else {
							for (var i = 0; i < deps.length; i++) {
								if (deps[i] !== unpack.captured_deps[i]) {
									match = false;
									break;
								}
							}
						}
						if (!match) corrupt(value, "function param mismatch with earlier function; all must be identical");
					}

					fn_bodies.push([
						target,
						unpack.fn_type,
						code.slice(value.body.start, value.body.end),
					]);
					this.node_map[key][target] = unpack.fn_node;
					this.can_inline_map[key][target] = unpack.can_inline;
				}
			}

			translation_list.push({key, deps, is_new, is_deleted, is_fuzzy, context, refs, fn_bodies, metadata_fields});
		}

		this.translation_list = translation_list;
		this.preamble = code.slice(0, export_path.node.start);
	}

	lookup(key, lang) {
		if (!this.node_map[key]) return undefined;
		return this.node_map[key][lang];
	}

	can_inline(key, lang) {
		if (!this.can_inline_map[key]) return undefined;
		return this.can_inline_map[key][lang];
	}

	visit_src(src) {
		this.seen_src_tags_map[src] = [];
	}

	register_tag(src, tag) {
		this.seen_src_tags_map[src].push(tag);
	}

	commit(opts) {
		var n_new_translations = 0;
		var n_deleted_translations = 0;

		const tab = (n) => {
			var s = "";
			for (var i = 0; i < n; i++) s += opts.tab;
			return s;
		};

		/* generate new translations */
		var new_translations = {};
		var new_translation_keys = [];
		for (const src in this.seen_src_tags_map) {
			for (const tag of this.seen_src_tags_map[src]) {
				const key = tag.key;
				if (this.known_keys[key]) {
					continue;
				}
				var new_translation = new_translations[key];
				if (!new_translation) {
					var type;
					var fn_body = "";
					if (!tag.is_multiline) {
						type = "expression";
						fn_body += "<O>" + tag.body + "</O>";
					} else {
						type = "block";
						var lines = [...tag.lines];
						const last_line = lines.pop() || '';
						const shift = () => lines.shift() || '';
						fn_body += "{\n"
						fn_body += tab(3) + "return (\n";
						fn_body += tab(4) + "<O>" + shift() + "\n";
						while (lines.length > 0) fn_body += tab(4) + shift() + "\n";
						fn_body += tab(4) + last_line + "</O>\n"
						fn_body += tab(3) + ");\n";
						fn_body += tab(2) + "}";
					}
					new_translation = {
						is_new: true,
						key: key,
						refs: [],
						context: tag.context,
						deps: tag.deps,
						fn_bodies: opts.langs.map(lang => [lang, type, fn_body]),
						metadata_fields: []
					};
					new_translations[key] = new_translation;
					new_translation_keys.push(key);
				}
				new_translation.refs.push([src, tag.loc.start.line]);
			}
		}

		/* generate new refs, and find deleted translations */
		var src_exists = {};
		for (var e of this.translation_list) {
			var new_refs = [];
			for (const [src, line] of e.refs) {
				/* completely remove refs if src no longer
				 * exists */
				if (src_exists[src] === undefined) src_exists[src] = fs.existsSync(src);
				if (!src_exists[src]) {
					continue;
				}

				if (!this.seen_src_tags_map[src]) {
					/* pass refs as-is for files not
					 * visisted */
					new_refs.push([src, line]);
				} else {
					/* for files visited, construct refs
					 * from seen tags */
					for (const tag of this.seen_src_tags_map[src]) {
						if (tag.key === e.key) {
							new_refs.push([src, tag.loc.start.line]);
						}
					}
				}
			}

			/* no refs means the translation is deleted */
			if (new_refs.length === 0 && !e.is_deleted) {
				e.is_deleted = true;
				n_deleted_translations++;
			}

			/* regenerate refs as an ordered set */
			var new_ref_set = {};
			for (const ref of new_refs) {
				const key = ref[0] + ":" + ref[1];
				new_ref_set[key] = ref;
			}
			e.refs = Object.values(new_ref_set).sort((a,b) => {
				const [src_a, src_b] = [a[0], b[0]];
				if (src_a < src_b) return -1;
				if (src_a > src_b) return 1;
				const [line_a, line_b] = [a[1], b[1]];
				return line_a - line_b;
			});
		}

		/* TODO fuzzyness! I need the metadata file for this, in order
		 * to know the original context/deps/body */

		for (const k of new_translation_keys) {
			n_new_translations++;
			const new_translation = new_translations[k];

			if (opts.append) {
				this.translation_list.push(new_translation);
			} else {
				/* !opts.append means "relative insertion"
				 * which is a "best effort" attempt to find a
				 * suitable translation insertion point
				 * relative to other translations. if there are
				 * translations in the same file, then the new
				 * translation is "sandwiched in". otherwise,
				 * an attempt is made to insert it after the
				 * last translation in the first file that
				 * comes before this one, lexicographically */
				const new_ref = new_translation.refs[0];
				var best_insertion_line_distance = undefined;
				var best_insertion_index = undefined;
				var lowest_line_number = undefined;
				var lowest_line_number_index = undefined;
				var closest_file = undefined;
				var closest_file_line_number = undefined;
				var closest_file_index = undefined;
				const new_ref_line_number = new_ref[1];
				for (var i = 0; i < this.translation_list.length; i++) {
					const t = this.translation_list[i];
					for (const existing_ref of t.refs) {
						const existing_ref_line_number = existing_ref[1];
						const existing_ref_file = existing_ref[0];
						const new_ref_file = new_ref[0];

						if (existing_ref_file !== new_ref_file) {
							/* not same file */
							if (new_ref_file > existing_ref_file) {
								if (closest_file === undefined || existing_ref_file >= closest_file) {
									closest_file = existing_ref_file;
									if (closest_file_line_number === undefined || existing_ref_line_number > closest_file_line_number) {
										closest_file_line_number = existing_ref_line_number;
										closest_file_index = i;
									}
								}
							}
							continue;
						}

						if (lowest_line_number === undefined || existing_ref_line_number < lowest_line_number) {
							lowest_line_number = existing_ref_line_number;
							lowest_line_number_index = i;
						}

						const line_distance = new_ref_line_number - existing_ref_line_number;
						if (line_distance < 1) continue;

						if (best_insertion_line_distance === undefined || line_distance < best_insertion_line_distance) {
							best_insertion_line_distance = line_distance;
							best_insertion_index = i;
						}
					}
				}

				const insert_translation_at = (index) => {
					this.translation_list.splice(index, 0, new_translation);
				};
				if (best_insertion_index !== undefined) {
					insert_translation_at(best_insertion_index + 1);
				} else if (lowest_line_number_index !== undefined) {
					insert_translation_at(lowest_line_number_index);
				} else if (closest_file_index !== undefined) {
					insert_translation_at(closest_file_index + 1);
				} else {
					insert_translation_at(0);
				}
			}
		}


		var output = "";

		output += this.preamble;
		output += "export default {\n";
		var first = true;
		for (const e of this.translation_list) {
			if (!first) output += "\n";
			output += tab(1) + JSON.stringify(e.key) + ": {\n";

			// rewrite metadata fields
			for (const [metadata_key, metadata_body] of e.metadata_fields) {
				output += tab(2) + JSON.stringify(metadata_key) + ": " + metadata_body + ",\n";
			}

			// write is_new, possibly
			if (e.is_new) output += tab(2) + '"_new": true, // FIXME remove this line when translation is done\n';

			// write is_deleted, possibly
			if (e.is_deleted) output += tab(2) + '"_deleted": true, // FIXME translation has no references; delete this entire section if you no longer need it\n';

			// write is_fuzzy, possibly
			if (e.is_fuzzy) output += tab(2) + '"_fuzzy": true, // FIXME verify that source and translations match each other; delete this line when you are satisfied\n';

			// write context, possibly
			if (e.context.length > 0) output += tab(2) + '"_context": ' + JSON.stringify(e.context) + ",\n";

			// write refs
			if (e.refs.length === 0) {
				output += tab(2) + '"_refs": [],\n';
			} else {
				output += tab(2) + '"_refs": [\n';
				for (const ref of e.refs) {
					var refstr = ref[0] + ":" + ref[1];
					output += tab(3) + JSON.stringify(refstr) + ",\n";
				}
				output += tab(2) + '],\n';
			}

			// write translations
			var fn_deps = (e.deps || []).join(", ");
			for (const [target, type, fn_body] of e.fn_bodies) {
				if (type === "block") {
					output += tab(2) + JSON.stringify(target) + ": (" + fn_deps + ") => ";
					output += fn_body;
					output += ",\n";
				} else if (type === "expression") {
					output += tab(2) + JSON.stringify(target) + ": (" + fn_deps + ") => " + fn_body + ",\n";
				} else {
					throw new Error("invalid type: " + type);
				}
			}

			output += tab(1) + "},\n";
			first = false;
		}
		output += "}\n";

		fs.writeFileSync(opts.translations_file, output);
		console.log("\nDONE!");
		console.log("  added:   " + n_new_translations);
		console.log("  deleted: " + n_deleted_translations);
	}
}



module.exports = { TraksError, is_translation_tag_node, process_path, replace, bake, bake_translations_export, options, Translations }

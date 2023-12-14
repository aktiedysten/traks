const assert = require("assert");
const crypto = require("crypto");
const traverse = require("@babel/traverse").default;
const fs = require("fs");

/* FIXME probably want to be able to override this at some point, but config
 * file stuff sucks to implement... maybe I'd like to put it in package.json,
 * like Babel does, but their .babelrc/package.json solution is homegrown and
 * not reusable (see:
 * babel-core/lib/transformation/file/options/build-config-chain.js) */
const options = {
	translation_tag: "T",
	//translation_fn: "_", /* TODO gettext-style, but with deps-support? */
};

class TraksError extends Error {
	constructor(filename, loc, msg) {
		if (!loc) loc = { start: "???" };
		super(`at ${filename}:${loc.start.line}: ${msg}`);
		this.filename = filename;
		this.loc = loc;
		this.msg = msg;
	}
}

const is_translation_tag_node = (node) => {
	if (node.type !== "JSXElement") {
		return false;
	}

	return node.openingElement.name.name === options.translation_tag;
};

const get_filename = (path) => {
	return path.hub.file.opts.filename;
};

const assert_non_nested_translation_path = (path) => {
	let n = path.parent;
	while (n) {
		if (is_translation_tag_node(n)) {
			const T = options.translation_tag;
			throw new TraksError(
				get_filename(path),
				path.node.loc,
				"translation <" + T + ">-tags cannot be nested"
			);
		}
		n = n.parent;
	}
};

const is_react_component_name = (name) => name[0] === name[0].toUpperCase();

function get_true_identifier_name(node) {
	if (node.loc.identifierName) return node.loc.identifierName;
	return node.name;
}

const capture_dependencies = (root_path, deps) => {
	const disallow_functions = (path) => {
		throw new TraksError(
			get_filename(path),
			path.node.loc,
			"translation tags cannot have inline functions"
		);
	};

	traverse(root_path, {
		noScope: true,

		JSXIdentifier: (path) => {
			const name = path.node.name;
			if (!is_react_component_name(name)) return; // ignore html (non-react component) tags
			deps.push(name);
		},
		Identifier: (path) => {
			const p = path.parent;
			let do_extract_name = false;
			if (p && p.type === "MemberExpression") {
				if (path.node === p.object) {
					do_extract_name = true;
				}
			} else if (p && p.type === "ObjectProperty") {
				if (path.node === p.value) {
					do_extract_name = true;
				}
			} else {
				do_extract_name = true;
			}
			if (do_extract_name) deps.push(get_true_identifier_name(path.node));
		},
		ThisExpression: (path) => {
			throw path.buildCodeFrameError(
				"'this' is not allowed within <T>-tags"
			);
		},
		ArrowFunctionExpression: disallow_functions,
		FunctionExpression: disallow_functions,
	});
};

// these normalizers remove leading/trailing whitespace and collapse whitespace
// sequences for the purpose of making a signature/key.
const signature_normalizers = [
	s=>s
		.replace(/^[ \t]+/gm, "") // remove leading whitespace
		.replace(/[ \t]+$/gm, "") // remove trailing whitespace
		.replace(/[ \t]+/g, " ")  // collapse whitespace
	,
	s=>s
		.replaceAll("\r", "")     // remove carriage returns
		.replace(/^[ \t]+/gm, "") // remove leading whitespace
		.replace(/[ \t]+$/gm, "") // remove trailing whitespace
		.replaceAll("\n", " ")    // convert new lines to whitespace
		.replace(/[ \t]+/g, " ")  // collapse whitespace
	,
];

const process_path = (path, signature_normalizer_version) => {
	const node = path.node;

	const signature_normalizer = signature_normalizers[signature_normalizer_version];
	if (!signature_normalizer) {
		throw new Error("invalid signature_normalizer_version");
	}

	if (!is_translation_tag_node(path.node)) {
		throw new TraksError(
			get_filename(path),
			path.node.loc,
			"expected translation tag node"
		);
	}
	assert_non_nested_translation_path(path);

	const code = path.hub.file.code;
	const body = code.slice(node.openingElement.end, node.closingElement.start);

	let deps = [];
	let context = "";

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
					throw new TraksError(
						get_filename(path),
						value.loc,
						"expected jsx expression for 'deps' attribute"
					);
				}
				if (value.expression.type !== "ArrayExpression") {
					throw new TraksError(
						get_filename(path),
						value.expression.loc,
						"expected jsx expression containing array for 'deps' attribute"
					);
				}
				for (const e of value.expression.elements) {
					if (e.type !== "Identifier") {
						throw new TraksError(
							get_filename(path),
							e.loc,
							`expected Identifier in 'deps' array, got ${e.type}`
						);
					}
					deps.push(e.name);
				}
				break;
			}
			case "context": {
				const value = attr.value;
				if (value.type !== "StringLiteral") {
					throw new TraksError(
						get_filename(path),
						value.loc,
						"expected string literal for 'context' attribute"
					);
				}
				context = value.value;
				break;
			}
			case "key":
				// "key" is React specific
				break;
			case "style":
				break;
			case "__self":
			case "__source":
				break;
			default:
				/* disallow unknown attributes */
				throw new TraksError(
					get_filename(path),
					path.node.loc,
					`invalid attribute name: '${name}'`
				);
		}
	}

	/* find dependencies inside translation tag: these are:
	 *   - React-component names
	 *   - identifiers
	 * also, functions are disallowed because they complicate
	 * dependency analysis (you can always lift functions out of
	 * translation tags, which is totally fine) */
	for (const child of path.node.children) {
		capture_dependencies(child, deps);
	}

	/* convert deps into ordered set */
	let dep_set = {};
	for (const dep of deps) dep_set[dep] = true;
	deps = Object.keys(dep_set);
	deps = deps.sort();

	// calculate signature + hash
	const signature = signature_normalizer(body) + "\x00" + context + "\x00" + deps.join(",");
	const key = crypto
		.createHash("sha256")
		.update(signature)
		.digest("hex")
		.slice(0, 12);

	const loc = node.loc;

	let is_multiline = false;
	let lines = [];
	if (loc.end.line > loc.start.line) {
		is_multiline = true;
		let i;
		for (i = node.openingElement.start - 1; i >= 0; i--) {
			const ch = code[i];
			if (ch === "\n") {
				i++;
				break;
			}
		}

		let pre = "";
		for (; i < node.openingElement.start; i++) {
			const ch = code[i];
			if (ch === " " || ch === "\t") {
				pre += ch;
			} else {
				break;
			}
		}

		for (let line of body.split("\n")) {
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
		t.jSXAttribute(
			t.jSXIdentifier("deps"),
			t.jSXExpressionContainer(
				t.arrayExpression(deps.map((dep) => t.identifier(dep)))
			)
		),
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

const replace = (babel, path, keep_children, signature_normalizer_version) => {
	if (path.node.was_traksed) return; // prevent infinite recursion...
	const t = babel.types;

	const { key, deps } = process_path(path, signature_normalizer_version);

	const is_self_closing = !keep_children;
	const children = keep_children ? path.node.children : [];

	let attributes = get_key_deps_attributes(t, key, deps);
	attributes = patch_key_attr(attributes, path);
	const JT = t.jSXIdentifier(options.translation_tag);
	let element = t.jSXElement(
		t.jSXOpeningElement(JT, attributes, is_self_closing),
		t.JSXClosingElement(JT),
		children,
		is_self_closing
	);
	element.was_traksed = true;
	path.replaceWith(element);
};

const bake = (babel, path, translations, try_langs, signature_normalizer_version) => {
	if (path.node.was_traksed) return; // prevent infinite recursion...
	const t = babel.types;
	const { key, deps } = process_path(path, signature_normalizer_version);

	let lang, node;
	for (lang of try_langs) {
		node = translations.lookup(key, lang);
		if (node) break;
	}

	if (!node)
		throw path.buildCodeFrameError(
			"translation not found: lookup(" +
				JSON.stringify(key) +
				", " +
				JSON.stringify(try_langs) +
				") failed"
		);

	/* Clone entire node subtree to prevent the same object reference from
	 * being used multiple times. This is necessary because some later
	 * transforms are not "pure" (i.e. they have side-effects; the node
	 * object itself is being modified). Making a deep clone prevents a
	 * problem where using identical <T/> snippets twice or more can cause
	 * a "syntax error" (it expects a JSX* node but instead sees a
	 * CallExpression) */
	node = t.cloneDeep(node);

	let children;
	let attributes;
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

	let element = t.jSXElement(
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
		throw new Error("corrupt translations file at " + at + ": " + reason);
	}
};

const unpack_translation_function = (node) => {
	let captured_deps = [];
	let dep_set = {};
	for (const param of (node.params || [])) {
		assert_type(param, "Identifier");
		captured_deps.push(param.name);
		dep_set[param.name] = true;
	}

	let can_inline;

	const btype = node.body.type;
	if (btype === "BlockStatement") {
		can_inline = false;
	} else {
		let body_deps = [];
		for (const child of node.body.children) {
			capture_dependencies(child, body_deps);
		}
		can_inline = true;
		for (const dep of body_deps) {
			if (dep_set[dep]) continue;
			can_inline = false;
			break;
		}
	}

	let fn_type, fn_node;
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

const bake_translations_export = (babel, path, try_langs) => {
	if (path.node.was_traksed) return; // prevent infinite recursion...
	const t = babel.types;
	const decl_path = path.get("declaration");

	let new_properties = [];
	assert_type(decl_path.node, "ObjectExpression");
	for (const prop_path of decl_path.get("properties")) {
		const prop = prop_path.node;
		assert_type(prop, "ObjectProperty");
		assert_type(prop.key, "StringLiteral");
		assert_type(prop.value, "ObjectExpression");
		const key = prop.key.value;
		let lang_epath_map = {};
		for (const epath of prop_path.get("value").get("properties")) {
			const e = epath.node;
			assert_type(e, "ObjectProperty");
			assert_type(e.key, "StringLiteral");
			const target_lang = e.key.value;
			lang_epath_map[target_lang] = epath;
		}

		let use_epath;
		for (const lang of try_langs) {
			let epath = lang_epath_map[lang];
			if (epath) {
				use_epath = epath;
				break;
			}
		}

		if (!use_epath) throw new Error("use_epath is not set");

		assert_type(use_epath.node.value, "ArrowFunctionExpression");

		const unpack = unpack_translation_function(use_epath.node.value);
		if (!unpack.can_inline) {
			new_properties.push(
				t.objectProperty(t.stringLiteral(key), use_epath.node.value)
			);
		}
	}

	let element = t.exportDefaultDeclaration(
		t.objectExpression(new_properties)
	);
	element.was_traksed = true;
	path.replaceWith(element);
};

function quoteattr(s) {
	const CR = '&#13;';
	return ('' + s)
		.replace(/&/g, '&amp;')
		.replace(/'/g, '&apos;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\r\n/g, CR) /* Must be before the next replacement. */
		.replace(/[\r\n]/g, CR);
	;
}

const array2set = (xs) => {
	let set = {};
	for (const x of xs || []) set[x] = true;
	return set;
};

const tag_leaf_set = array2set([ "area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr" ]);

class Translations {
	constructor(babel, babel_plugins, translations_path) {
		this.seen_src_tags_map = {};
		this.known_keys = {};
		this.node_map = {};
		this.can_inline_map = {};
		this.refs = {};

		this.translations_path = translations_path;
		this.babel = babel;
		this.babel_plugins = babel_plugins;

		this.parse_translations_file();
	}

	parse_translations_file() {
		let export_path = null;
		this.code = fs.readFileSync(this.translations_path).toString();
		const tx = this.babel.transform(this.code, {
			filename: this.translations_path,
			babelrc: false,
			configFile: false,
			plugins: [
				...this.babel_plugins,
				[
					function (babel) {
						return {
							visitor: {
								ExportDefaultDeclaration(path) {
									if (export_path !== null)
										throw new Error(
											"found multiple exports"
										);
									export_path = path;
								},
							},
						};
					},
					{ legacy: true },
				],
			],
		});

		if (!export_path) corrupt(null, "found no default export");

		const declaration = export_path.node.declaration;

		assert_type(declaration, "ObjectExpression");

		this.translation_list = [];
		for (const key_prop of declaration.properties) {
			assert_type(key_prop, "ObjectProperty");
			const extractKeyName = (x) => {
				let result =
					x.key.type === "StringLiteral"
						? x.key.value
						: x.key.type === "Identifier"
						? x.key.name
						: null;
				assert(null !== result);
				return result;
			};

			const key = extractKeyName(key_prop);
			this.known_keys[key] = true;
			const body_path = key_prop.value;
			assert_type(body_path, "ObjectExpression");

			let deps = null;
			let dep_set = {};
			let is_new = false;
			let is_deleted = false;
			let context = "";
			if (!this.refs[key]) this.refs[key] = [];
			let refs = this.refs[key];
			let fn_bodies = [];
			let nodes = [];
			this.node_map[key] = {};
			this.can_inline_map[key] = {};
			for (const target_prop of body_path.properties) {
				assert_type(target_prop, "ObjectProperty");
				const target = extractKeyName(target_prop);

				const value = target_prop.value;

				const chk_bool = (field) => {
					if (target !== field) return false;
					assert_type(value, "BooleanLiteral");
					if (!value.value)
						corrupt(
							value,
							"only 'true' is a valid value for " + field
						);
					return true;
				};

				if (chk_bool("_new")) {
					is_new = true;
				} else if (chk_bool("_deleted")) {
					is_deleted = true;
				} else if (target === "_context") {
					assert_type(value, "StringLiteral");
					context = value.value;
				} else if (target === "_refs") {
					/* legacy support for traks versions
					 * 1.0.7 and below; refs were moved to
					 * cache file in v1.0.8+ */
					assert_type(value, "ArrayExpression");
					for (const element of value.elements) {
						assert_type(element, "StringLiteral");
						const xs = element.value.split(":");
						if (xs.length !== 2)
							corrupt(element, "ref not on <Path>:<line> form");
						const [path, line_str] = xs;
						const line = parseInt(line_str, 10);
						if (isNaN(line))
							corrupt(element, "invalid line number in ref");
						const ref = [path, line];
						refs.push(ref);
					}
				} else {
					assert_type(value, "ArrowFunctionExpression");

					const unpack = unpack_translation_function(value);

					if (deps === null) {
						deps = unpack.captured_deps;
					} else {
						let match = true;
						if (deps.length !== unpack.captured_deps.length) {
							match = false;
						} else {
							for (let i = 0; i < deps.length; i++) {
								if (deps[i] !== unpack.captured_deps[i]) {
									match = false;
									break;
								}
							}
						}
						if (!match)
							corrupt(
								value,
								"function param mismatch with earlier function; all must be identical"
							);
					}

					nodes.push({
						lang: target,
						node: value,
					});

					fn_bodies.push([
						target,
						unpack.fn_type,
						this.code.slice(value.body.start, value.body.end),
					]);
					this.node_map[key][target] = unpack.fn_node;
					this.can_inline_map[key][target] = unpack.can_inline;
				}
			}

			this.translation_list.push({
				key,
				deps,
				is_new,
				is_deleted,
				context,
				refs,
				fn_bodies,
				nodes,
			});
		}

		let export_start = export_path.node.start;
		if (export_start === undefined) throw new Error("invalid export start");
		this.preamble = this.code.slice(0, export_start);
	}

	export_json() {
		const node_transmogrify = (n) => {
			let o_tags = [];

			const export_tag_attribute_value = (x) => {
				switch (x.type) {
				case "StringLiteral":
					return ["A:TEXT", x.extra.raw[0], x.value];
				case "JSXExpressionContainer":
					return ["A:EXPR", this.code.slice(x.start, x.end)];
				default: throw new Error("unhandled tag attribute value type: " + x.type);
				}
			};

			const export_tag_attribute = (x) => {
				if (x.type !== "JSXAttribute") throw new Error("expected JSXAttribute");
				if (x.name.type !== "JSXIdentifier") throw new Error("expected `name` in JSXAttribute to be a JSXIdentifier; got " + x.name.type);
				return [x.name.name, export_tag_attribute_value(x.value)];
			};

			const export_tag_attributes = (xs) => {
				return xs.map(export_tag_attribute);
			};

			let export_children, export_node;

			export_node = (x) => {
				switch (x.type) {
				case "JSXText":
					return ["TEXT", x.value];
				case "JSXElement":
					return [
						"TAG",
						x.openingElement.name.name,
						export_tag_attributes(x.openingElement.attributes),
						export_children(x.children),
					];
				case "JSXExpressionContainer":
					return ["EXPR", this.code.slice(x.start, x.end)];
				default: throw new Error("unhandled node-type: " + x.type);
				}
			};

			export_children = (xs) => {
				return xs.map(export_node);
			};

			traverse(n, {
				noScope: true,
				JSXIdentifier: (path) => {
					if (path.node.name !== "O" || path.parent.type !== "JSXOpeningElement") return;
					let node = export_children(path.parentPath.parent.children);
					o_tags.push({
						node,
					});
				},
			});
			return o_tags;
		};

		let list = [];
		for (const x0 of this.translation_list) {
			let translations = [];
			for (const x1 of x0.nodes) {
				translations.push({
					lang: x1.lang,
					nodes: node_transmogrify(x1.node),
				});
			}

			list.push({
				key: x0.key,
				is_new: x0.is_new,
				is_deleted: x0.is_deleted,
				translations,
			});
		}

		return {
			list,
		};
	}

	import_json_trinfo_patch(patch) {
		let patch_map = {};
		for (const x of patch.list) {
			patch_map[x.key] = x;
		}

		let extract_o_tag_ranges_from_fn_body = (fn_body, expected_count) => {
			// fn_body is prefixed with a "function header" to make
			// it parsable by Babel; works for both block function
			// bodies (`{...code...}` => `()=>{...code...}`), and
			// expressions (`<O>foo</O>` => `()=><O>foo</o>`.
			const stub_prefix = "()=>";
			const offset = stub_prefix.length;
			let code = stub_prefix+fn_body;

			let ranges = [];

			this.babel.transform(code, {
				filename: "stub.js",
				babelrc: false,
				configFile: false,
				plugins: [
					...this.babel_plugins,
					[
						function (babel) {
							return {
								visitor: {
									JSXIdentifier(path) {
										if (path.node.name !== "O" || path.parent.type !== "JSXOpeningElement") return;
										let ppp = path.parentPath.parent;
										ranges.push([ppp.start - offset , ppp.end - offset]);
									},
								},
							};
						},
						{ legacy: true },
					],
				],
			});

			return ranges;
		};

		let node2code; node2code = (node) => {
			const n0 = node[0];
			if (typeof node === "object" && node.length === 0) {
				return "";
			} else if (typeof n0 === "object") {
				return node.map(n => node2code(n)).join("");
			} else if (n0 === "TEXT") {
				return node[1].replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\n\t\t\t\t");
			} else if (n0 === "TAG") {
				let tag = node[1];
				let is_leaf = !!tag_leaf_set[tag.toLowerCase()];
				let attr_code = "";
				let attr_tuples = node[2];
				for (const attr_tuple of attr_tuples) {
					let name = attr_tuple[0];
					attr_code += " "+name+"=";
					let value_tuple = attr_tuple[1];
					let attr_type = value_tuple[0];
					if (attr_type === "A:TEXT") {
						let quote = value_tuple[1];
						let value = value_tuple[2];
						attr_code += quote + quoteattr(value) + quote;
					} else if (attr_type === "A:EXPR") {
						let code = value_tuple[1];
						attr_code += code; // curly braces included in value
					} else {
						throw new Error("unhandled attribute type: " + attr_type);
					}
				}
				if (is_leaf) {
					return "<"+tag+attr_code+"/>";
				} else {
					return "<"+tag+attr_code+">" + node2code(node[3]) + "</"+tag+">";
				}
			} else if (n0 === "EXPR") {
				return node[1];
			} else {
				throw new Error("node2code failed on: " + JSON.stringify(node));
			}
		};

		let patch_substring = (str, range, replacement) => {
			const n = str.length;
			const i0 = range[0];
			const i1 = range[1];
			assert(0 <= i0 && i0 <= n);
			assert(0 <= i1 && i1 <= n);
			assert(i0 <= i1);
			return str.slice(0, range[0]) + replacement + str.slice(range[1]);
		};

		for (const orig of this.translation_list) {
			let p = patch_map[orig.key];
			if (!p) continue;

			// patch in ''new''-flag
			if (p.is_new !== undefined) {
				orig.is_new = p.is_new;
			}

			// patch translations
			for (const t of p.translations) {
				let lang = t.lang;
				let fn_body_tuple = null;

				let fn_body_index;
				for (const index in orig.fn_bodies) {
					const fb = orig.fn_bodies[index];
					if (fb[0] === lang) {
						fn_body_tuple = fb;
						fn_body_index = index;
						break;
					}
				}
				if (!fn_body_tuple) continue;

				let fn_body_type = fn_body_tuple[1];
				let fn_body = fn_body_tuple[2];

				const N = t.nodes.length;
				let patched_fn_body = fn_body;

				let extract_rec = () => {
					let o_tag_ranges = extract_o_tag_ranges_from_fn_body(patched_fn_body);
					if (o_tag_ranges.length !== N) {
						throw new Error("found unexpected number of <O>-tags: " + JSON.stringify({
							expected_o_tag_count: N,
							actual_o_tag_count: o_tag_ranges.length,
							at_iteration: i,
							original_fn_body: fn_body,
							current_fn_body: patched_fn_body,
						}));
					}
					if (fn_body_type === "expression" && N !== 1) {
						throw new Error("expected only one <O>-tag for ''expression''-type function body, but found " + N);
					}
					return o_tag_ranges;
				};

				for (let i = 0; i < N; i++) {
					let o_tag_ranges = extract_rec();
					let node = t.nodes[i];
					let node_code = node2code(node);
					let range = o_tag_ranges[i];
					patched_fn_body = patch_substring(patched_fn_body, range, "<O>"+node_code+"</O>");
				}
				extract_rec(); // just for the error checking

				// we're done; replace the stored function body
				// (will we written back into
				// traks-translations.js when calling
				// this.commit())
				orig.fn_bodies[fn_body_index][2] = patched_fn_body;
			}
		}
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

	map_keys(keymap) {
		let remap = {};
		for (const t of this.translation_list) {
			if (t.is_deleted) continue;
			const old_key = t.key;
			const new_key = keymap[t.key];
			if (!new_key) throw new Error("key " + t.key + " could not be mapped: refusing to continue; did you forget to update translations before this operation?");
			if (new_key === old_key) continue;
			if (remap[old_key] === undefined) {
				remap[old_key] = new_key;
				console.log("Will map key " + old_key + " to " + new_key);
			}
			t.key = new_key;
		}
		for (const old_key in remap) {
			const new_key = remap[old_key];
			for (const prop of ["known_keys", "node_map", "can_inline_map", "refs"]) {
				if (this[prop][new_key] !== undefined) {
					throw Error("cannot map old key (" + old_key + ") to new key (" + new_key + ") for prop \"" + prop + "\" because we already have a value for new key");
				}
				this[prop][new_key] = this[prop][old_key]
				delete this[prop][old_key];
			}
		}
	}

	commit(opts) {
		let n_new_translations = 0;
		let n_deleted_translations = 0;

		const tab = (n) => {
			let s = "";
			for (let i = 0; i < n; i++) s += opts.tab;
			return s;
		};

		let new_translations = {};
		let new_translation_keys = [];
		let seen_key_refs = {};
		for (const src in this.seen_src_tags_map) {
			for (const tag of this.seen_src_tags_map[src]) {
				const key = tag.key;
				const ref = [src, tag.loc.start.line];
				if (!seen_key_refs[key]) seen_key_refs[key] = [];
				seen_key_refs[key].push(ref);

				if (this.known_keys[key]) {
					continue;
				}

				/* generate new translation */
				let new_translation = new_translations[key];
				if (!new_translation) {
					let type;
					let fn_body = "";
					if (!tag.is_multiline) {
						type = "expression";
						fn_body += "<O>" + tag.body + "</O>";
					} else {
						type = "block";
						let lines = [...tag.lines];
						const last_line = lines.pop() || "";
						const shift = () => lines.shift() || "";
						fn_body += "{\n";
						fn_body += tab(3) + "return (\n";
						fn_body += tab(4) + "<O>" + shift() + "\n";
						while (lines.length > 0)
							fn_body += tab(4) + shift() + "\n";
						fn_body += tab(4) + last_line + "</O>\n";
						fn_body += tab(3) + ");\n";
						fn_body += tab(2) + "}";
					}
					new_translation = {
						is_new: true,
						key: key,
						refs: [],
						context: tag.context,
						deps: tag.deps,
						fn_bodies: opts.langs.map((lang) => [
							lang,
							type,
							fn_body,
						]),
					};
					new_translations[key] = new_translation;
					new_translation_keys.push(key);
				}
				new_translation.refs.push(ref);
			}
		}

		/* generate new refs, and find deleted translations */
		let src_exists = {};
		for (let e of this.translation_list) {
			if (seen_key_refs[e.key]) {
				for (const ref of seen_key_refs[e.key]) {
					e.refs.push(ref);
				}
			}

			let new_refs = [];
			for (const [src, line] of e.refs) {
				/* completely remove refs if src no longer
				 * exists */
				if (src_exists[src] === undefined)
					src_exists[src] = fs.existsSync(src);
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
			if (new_refs.length === 0 && !e.is_deleted && !opts.is_patch) {
				e.is_deleted = true;
				n_deleted_translations++;
			}

			/* regenerate refs as an ordered set */
			let new_ref_set = {};
			for (const ref of new_refs) {
				const key = ref[0] + ":" + ref[1];
				new_ref_set[key] = ref;
			}
			e.refs = Object.values(new_ref_set).sort((a, b) => {
				const [src_a, src_b] = [a[0], b[0]];
				if (src_a < src_b) return -1;
				if (src_a > src_b) return 1;
				const [line_a, line_b] = [a[1], b[1]];
				return line_a - line_b;
			});
		}

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
				let best_insertion_line_distance = undefined;
				let best_insertion_index = undefined;
				let lowest_line_number = undefined;
				let lowest_line_number_index = undefined;
				let closest_file = undefined;
				let closest_file_line_number = undefined;
				let closest_file_index = undefined;
				const new_ref_line_number = new_ref[1];
				for (let i = 0; i < this.translation_list.length; i++) {
					const t = this.translation_list[i];
					for (const existing_ref of t.refs) {
						const existing_ref_line_number = existing_ref[1];
						const existing_ref_file = existing_ref[0];
						const new_ref_file = new_ref[0];

						if (existing_ref_file !== new_ref_file) {
							/* not same file */
							if (new_ref_file > existing_ref_file) {
								if (
									closest_file === undefined ||
									existing_ref_file >= closest_file
								) {
									closest_file = existing_ref_file;
									if (
										closest_file_line_number ===
											undefined ||
										existing_ref_line_number >
											closest_file_line_number
									) {
										closest_file_line_number =
											existing_ref_line_number;
										closest_file_index = i;
									}
								}
							}
							continue;
						}

						if (
							lowest_line_number === undefined ||
							existing_ref_line_number < lowest_line_number
						) {
							lowest_line_number = existing_ref_line_number;
							lowest_line_number_index = i;
						}

						const line_distance =
							new_ref_line_number - existing_ref_line_number;
						if (line_distance < 1) continue;

						if (
							best_insertion_line_distance === undefined ||
							line_distance < best_insertion_line_distance
						) {
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

		let output = "";

		output += this.preamble;
		output += "export default {\n";
		let first = true;
		for (const e of this.translation_list) {
			if (!first) output += "\n";
			output += tab(1) + JSON.stringify(e.key) + ": {\n";

			// write is_new, possibly
			if (e.is_new)
				output +=
					tab(2) +
					'"_new": true, // FIXME remove this line when translation is done\n';

			// write is_deleted, possibly
			if (e.is_deleted)
				output +=
					tab(2) +
					'"_deleted": true, // FIXME translation has no references; delete this entire section if you no longer need it\n';

			// write context, possibly
			if (e.context.length > 0)
				output +=
					tab(2) + '"_context": ' + JSON.stringify(e.context) + ",\n";

			// write translations
			let fn_deps = (e.deps || []).join(", ");
			for (const [target, type, fn_body] of e.fn_bodies) {
				if (type === "block") {
					output +=
						tab(2) +
						JSON.stringify(target) +
						": (" +
						fn_deps +
						") => ";
					output += fn_body;
					output += ",\n";
				} else if (type === "expression") {
					output +=
						tab(2) +
						JSON.stringify(target) +
						": (" +
						fn_deps +
						") => " +
						fn_body +
						",\n";
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
		if (!opts.is_patch) {
			console.log("  added:   " + n_new_translations);
			console.log("  deleted: " + n_deleted_translations);
		}

		/* update refs passed to constructor (it's an input/output
		 * value */
		for (const t of this.translation_list) this.refs[t.key] = t.refs;
	}
}

module.exports = {
	TraksError,
	is_translation_tag_node,
	process_path,
	replace,
	bake,
	bake_translations_export,
	options,
	Translations,
	array2set,
};

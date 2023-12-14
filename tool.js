const babel = require('@babel/core');
const fs = require('fs');
const fspath = require('path');
const lib = require('./lib');

function is_react_component_name(name) {
	return name[0] === name[0].toUpperCase();
}

function readline() {
	const rl = require('readline-sync');
	const q = function (question) {
		return rl.question(question + ": ");
	};
	return {
		question: q,
		yN: function (question) {
			for (;;) {
				const a = q(question + " [y/N]").toLowerCase();
				if (a === "") return false;
				if (a === "y") return true;
				if (a === "n") return false;
				console.log("please answer y or n");
			}
		},
		Yn: function (question) {
			for (;;) {
				const a = q(question + " [Y/n]");
				if (a === "") return true;
				if (a === "y") return true;
				if (a === "n") return false;
				console.log("please answer y or n");
			}
		}
	}
}

const default_options = {
	langs: ['en'],
	src_dirs: ["src"],
	jsx_exts: ["js", "jsx"],

	append: false,

	translations_file: "src/traks-translations.js",
	import_file: "src/traks.js",

	babel_plugins: [
		'babel-plugin-syntax-jsx',
		'babel-plugin-syntax-object-rest-spread',
		'babel-plugin-syntax-class-properties',
		'babel-plugin-dynamic-import-node',
	],

	tab: "\t",

	signature_normalizer_version: 0,
}

const resolve_options = (opts) => {
	return {
		...default_options,
		...(opts||{}),
	};
};

function print_options(opts) {
	console.log("OPTIONS:");
	const popt = (opt) => {
		let value = opts[opt];
		if (typeof value === "object") value = value.join(",");
		console.log("  " + opt + ": " + value);
	};
	popt('langs');
	popt('src_dirs');
	popt('jsx_exts');
	console.log("  insert mode: " + (opts.append ? "append" : "relative insert"));
	popt('translations_file');
	popt('babel_plugins');
}

const construct_translations_object = (opts) => new lib.Translations(babel, opts.babel_plugins, opts.translations_file);

function visit_sources(opts, visitor) {
	const sources = (() => {
		let exclude_dirs = lib.array2set(opts.exclude_dirs);
		let exclude_files = lib.array2set(opts.exclude_files);
		let sources = [];
		let rec; rec = function (path) {
			const st = fs.statSync(path);
			if (st.isFile()) {
				if (exclude_files[fspath.basename(path)]) return;
				const ext = fspath.extname(path).toLowerCase();
				let is_jsx = false;
				for (const src_ext of opts.jsx_exts) {
					if (ext === ("." + src_ext)) {
						is_jsx = true;
						break;
					}
				}
				if (is_jsx) sources.push(path);
			} else if (st.isDirectory()) {
				if (exclude_dirs[fspath.basename(path)]) return;
				for (const sub of fs.readdirSync(path)) {
					rec(fspath.join(path, sub));
				}
			}
		};
		for (const dir of opts.src_dirs) rec(dir);

		return sources;
	})();


	for (const src of sources) {
		visitor(src);
	}

}

function get_translation_paths_from_src(opts, src) {
	let translation_paths = [];
	const tx = babel.transformFileSync(src, {
		babelrc: false,
		configFile: false,
		plugins: [
			...opts.babel_plugins,
			[function (babel) {
				return {
					visitor: {
						JSXElement(path) {
							if (!lib.is_translation_tag_node(path.node)) return;
							translation_paths.push(path);
						}
					}
				};
			}, {legacy:true}]
		],
	});
	return translation_paths;
}

function run_update(opts) {
	opts = resolve_options(opts);

	print_options(opts);

	const rl = readline();

	const required_file = (path, explain, stub) => {
		if (!fs.existsSync(path)) {
			if (!rl.Yn(path + " does not exist; create it?")) {
				console.log("Okay, bailing...");
				process.exit(0);
			}
			console.log(explain + "\n");
			if (typeof stub === "object") stub = stub.join("\n") + "\n";

			fs.writeFileSync(path, stub);
		}
		return fs.readFileSync(path);
	}

	required_file(
		opts.translations_file,

		"This is where you edit your translations, and it's updated whenever 'update' finds new/deleted translations. Put this in source control.",

		[
			"import React from 'react';",
			"const O = React.Fragment;",
			"",
			"// This is your translations file. It is automatically updated by `run_update()`",
			"// which parses and rewrites it, potentially adding new translations and",
			"// updating underscore-prefixed fields, to reflect changes in your main source.",
			"// To avoid nasty surprises you should follow these guidelines:",
			"//  - Everything before the export statement is rewritten as-is; you can add",
			"//    imports, functions and whatever you like here.",
			"//  - Everything inside the export statement, except for function bodies, is",
			"//    _rebuilt_. If you change anything here, then at best it will be overwritten",
			"//    by `traks update` (this includes writing comments), and at worst, it might",
			"//    cause `run_update()` to consider the file corrupt, and thus refuse to",
			"//    update it.",
			"//  - One exception is hash-prefixed keys, e.g. \"#comment\"; you can add these",
			"//    before underscore-prefixed fields and they'll be preserved. You can use",
			"//    these for your own needs, e.g. commenting on translations.",
			"//  - Function bodies can be in block-statement form, or in expression form.",
			"//    That is, both these examples are valid (and equivalent):",
			"//       \"en\": () => {",
			"//           return <O>Hello world!</O>",
			"//       },",
			"//       \"en\": () => <O>Hello world!</O>,",
			"//    Also, `run_update()` will not meddle with this once a translation is there,",
			"//    so you can convert between these two styles as you wish. New translations are",
			"//    added in expression form if they're one-liners.",
			"//  - It's a good idea to run `run_update()` before you commit since it verifies",
			"//    that the file is valid, and it might change formatting and update",
			"//    underscore-prefixed fields.",
			"//",
			"// See also the import file (" + opts.import_file + ") for more info on usage.",
			"",
			"export default {",
			"}"
		]
	);

	const mk_import = (from, to) => {
		let imp = fspath.relative(fspath.dirname(from), to);
		const p = fspath.parse(imp);
		imp = fspath.join(p.dir, p.name);
		if (imp[0] !== ".") imp = "./" + imp;
		return imp;
	};

	required_file(
		opts.import_file,

		"This is the file you import in your React code.\n" +
		"Please open it to see how it's used, and you're free to edit it to your needs ('update' will never change it after creating it)",

		[
			"import React from 'react';",
			"import translations from '" + mk_import(opts.import_file, opts.translations_file) + "';",
			"",
			"let setup, module;",
			"/* The Traks Babel-plugin replaces the \"TRAKS_COMPILE_TIME_MAGICK_CONST__*\"",
			" * string literals with true or false at compile time based on build mode set",
			" * via environment variables */",
			"if (\"TRAKS_COMPILE_TIME_MAGICK_CONST__IS_BAKED\") {",
			"\tsetup = require('traks/setup-baked');",
			"\tmodule = setup({",
			"\t\ttranslations,",
			"\t\tlang: \"TRAKS_COMPILE_TIME_MAGICK_CONST__LANG\",",
			"\t\tset_lang: (lang) => {",
			"\t\t\tconsole.log(\"TODO set lang\", lang); // TODO handle your language change here for baked builds",
			"\t\t}",
			"\t});",
			"} else {",
			"\tsetup = require('traks/setup');",
			"",
			"\t/* When a translation is missing, it gets wrapped in this component. You can omit it if you want. */",
			"\tconst TranslationMissing = function(props) {",
				"\t\treturn <span style={{backgroundColor:\"#f0f\",color:\"#ff0\"}}>{props.children || null}</span>;",
			"\t}",
			"",
			"\tmodule = setup({",
				"\t\ttranslations,",
				"\t\tdefault_lang: " + JSON.stringify(opts.langs[0]) + ",",
				"\t\ttranslation_missing_component: TranslationMissing,",
			"\t});",
			"}",
			"",
			"const { T, TraksProvider, TraksConsumer } = module;",
			"",
			"/* exports explained:",
			" *   T: your translation React component, examples:",
			" *       <T>translate me</T>                                       (simple translation)",
			" *       <T>will you <i>translate me</i>?</T>                      (you're not limited to text strings)",
			" *       <T>You have {count} unread message(s)</T>                 ('count' gets captured and provided as a dependency in your translations file)",
			" *       <T>Hello, <World/></T>                                    ('World' gets captured and provided as a dependency in your translations file)",
			" *       <T context='file'>Save</T> <T context='people'>Save</T>   (use context to provide different translations for the same content)",
			" *       <T deps={[count]}>You have several messages</T>           (a way to pass additional dependencies)",
			" *      Rules to follow:",
			" *       - you cannot nest <T>-tags; no \"<T>'s inside <T>'s\"",
			" *       - you cannot have inline functions in JSX expressions:",
			" *            <T>{x=>x}</T> is forbidden",
			" *            but <T><input placeholder=\"my translated placeholder\" onChange={on_change_fn}/></T> is fine!",
			" *       - <T> supports no attributes other than 'deps', 'context' and 'key' ('key' is React-specific)",
			" *      Otherwise, <T>-tags may be arbitrarily deep and complex, if you want rope to shoot yourself in the foot with :)",
			" *",
			" *   TraksProvider: wrap your entire application in this React-component (<T> will not work outside of it)",
			" *",
			" *   TraksConsumer: passes 'lang' and set_lang(lang) props to child",
			" *",
			" *   traks_set_lang(lang): globally sets language",
			" */",
			"export { T, TraksProvider, TraksConsumer }",
		]
	);

	let translations = construct_translations_object(opts);

	visit_sources(opts, (src) => {
		translations.visit_src(src);
		let translation_paths = get_translation_paths_from_src(opts, src);
		const tags = translation_paths.map(path => lib.process_path(path, opts.signature_normalizer_version));
		for (const tag of tags) translations.register_tag(src, tag);
	});

	if (translations) translations.commit(opts);
}

function dump_hashes(opts) {
	opts = resolve_options(opts);
	let locations = [];
	visit_sources(opts, (src) => {
		let translation_paths = get_translation_paths_from_src(opts, src);
		const tags = translation_paths.map(path => lib.process_path(path, opts.signature_normalizer_version));
		for (const tag of tags) {
			locations.push([src, tag.loc.start.line, tag.key]);
		}
	});

	const valcmp = (a,b) => a<b?-1:a>b?1:0;

	locations.sort((a,b) => {
		let d0 = valcmp(a[0], b[0]);
		if (d0 !== 0) return d0;
		let d1 = a[1] - b[1];
		return d1;
	});

	for (const loc of locations) {
		console.log(loc[0] + ":" + loc[1] + "\t" + loc[2]);
	}
}

function run_export_translations(opts) {
	print_options(opts);
	const path = "traks-export.json";
	console.log("Exporting " + path + " ...");
	opts = resolve_options(opts);
	let translations = construct_translations_object(opts);
	let ex = translations.export_json();
	fs.writeFileSync(path, JSON.stringify(ex, null, 2));
}

function trinfo_import_from_path(path, opts) {
	opts = resolve_options(opts);
	let patch = JSON.parse(fs.readFileSync(path));
	let translations = construct_translations_object(opts);
	translations.import_json_trinfo_patch(patch);
	translations.commit({...opts, is_patch:true});
}

function change_signature_normalizer_version(old_version, new_version) {
	throw new Error("XXX");
}

module.exports = {
	run_update,
	dump_hashes,
	run_export_translations,
	trinfo_import_from_path,
	change_signature_normalizer_version,
}

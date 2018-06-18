const babel = require('babel-core');
const fs = require('fs');
const crypto = require('crypto');
const fspath = require('path');
const util = require('./util');

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

const update_defaults = {
	langs: ['en'],
	src_dirs: ["src"],
	jsx_exts: ["js", "jsx"],

	append: false,
	fuzzyness: 0.15,

	translations_file: "src/traks-translations.js",
	import_file: "src/traks.js",
	metadata_file: "traks-metadata.json",
	cache_file: ".traks-cache.json",

	babel_plugins: ['babel-plugin-syntax-jsx', 'babel-plugin-syntax-object-rest-spread', 'babel-plugin-syntax-class-properties'],

	tab: "\t"
}

function run_update(opts) {
	console.log("update options:");
	{
		const popt = (opt) => {
			var value = opts[opt];
			if (typeof value === "object") value = value.join(",");
			console.log("  " + opt + ": " + value);
		};
		popt('langs');
		popt('src_dirs');
		popt('jsx_exts');
		console.log("  insert mode: " + (opts.append ? "append" : "relative insert"));
		popt('fuzzyness');
		popt('translations_file');
		popt('metadata_file');
		popt('cache_file');
		popt('babel_plugins');
	}

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
			"import { O } from 'traks/o';",
			"",
			"/* This is your translations file. It is automatically updated by `traks update`",
			" * which parses and rewrites it, potentially adding new translations and",
			" * updating underscore-prefixed fields, to reflect changes in your main source.",
			" * To avoid nasty surprises you should follow these guidelines:",
			" *  - Everything before the export statement is rewritten as-is; you can add",
			" *    imports, functions and whatever you like here.",
			" *  - Everything inside the export statement, except for function bodies, is",
			" *    _rebuilt_. If you change anything here, then at best it will be overwritten",
			" *    by `traks update` (this includes writing comments), and at worst, it might",
			" *    cause `traks update` to consider the file corrupt, and thus refuse to",
			" *    update it.",
			" *  - One exception is hash-prefixed keys, e.g. \"#comment\"; you can add these",
			" *    before underscore-prefixed fields and they'll be preserved. You can use",
			" *    these for your own needs, e.g. commenting on translations.",
			" *  - Function bodies can be in block-statement form, or in expression form.",
			" *    That is, both these examples are valid (and equivalent):",
			" *       \"en\": () => {",
			" *           return <O>Hello world!</O>",
			" *       },",
			" *       \"en\": () => <O>Hello world!</O>,",
			" *    Also, `traks update` will not meddle with this once a translation is there,",
			" *    so you can convert between these two styles as you wish. New translations are",
			" *    added in expression form if they're one-liners.",
			" *  - It's a good idea to run `traks update` before you commit since it verifies",
			" *    that the file is valid, and it might change formatting and update",
			" *    underscore-prefixed fields.",
			" *",
			" * See also the import file (" + opts.import_file + ") for more info on usage.",
			" */",
			"",
			"export default {",
			"}"
		]
	);

	const mk_import = (from, to) => {
		var imp = fspath.relative(fspath.dirname(from), to);
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
			"var setup, module;",
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

	required_file(
		opts.metadata_file,

		"This file contains metadata used by 'update'. You should put it in source control, but never edit it.",

		"{}"
	);

	if (!fs.existsSync(opts.cache_file)) {
		fs.writeFileSync(opts.cache_file, "{}");
	}
	var cache = JSON.parse(fs.readFileSync(opts.cache_file));

	if (!cache.sources) cache.sources = {};

	const sources = (() => {
		var sources = [];
		var rec; rec = function (path) {
			const st = fs.statSync(path);
			if (st.isFile()) {
				const ext = fspath.extname(path).toLowerCase();
				var is_jsx = false;
				for (const src_ext of opts.jsx_exts) {
					if (ext === ("." + src_ext)) {
						is_jsx = true;
						break;
					}
				}
				if (is_jsx) sources.push(path);
			} else if (st.isDirectory()) {
				for (const sub of fs.readdirSync(path)) {
					rec(fspath.join(path, sub));
				}
			}
		};
		for (const dir of opts.src_dirs) rec(dir);

		return sources;
	})();

	const babel_plugins = opts.babel_plugins.map(p => require.resolve(p));
	var translations = new util.Translations(babel, babel_plugins, opts.translations_file, opts.metadata_file);

	for (const src of sources) {
		var actual_sha256 = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
		var do_update = false;
		if (!cache.sources[src]) {
			cache.sources[src] = {};
			do_update = true;
		} else if (cache.sources[src].sha256 !== actual_sha256) {
			do_update = true;
		}
		cache.sources[src].sha256 = actual_sha256;
		if (!do_update) continue;

		translations.visit_src(src);

		var translation_paths = [];
		const tx = babel.transformFileSync(src, { babelrc: false, plugins: [
			...babel_plugins,
			function (babel) {
				return {
					visitor: {
						JSXElement(path) {
							if (!util.is_translation_tag_node(path.node)) return;
							translation_paths.push(path);
						}
					}
				};
			}
		]});

		const tags = translation_paths.map(path => util.process_path(path));
		for (const tag of tags) translations.register_tag(src, tag);
	}

	if (translations) {
		translations.commit(opts);
	}
	fs.writeFileSync(opts.cache_file, JSON.stringify(cache));
}

function run() {
	const args = process.argv.slice(2);

	var arg;
	const usage = (err) => {
		if (err) console.error("ERROR: " + err);
		console.error("usage: " + process.argv[1] + " [-v|--verbose] <command> ...");
		if (err) process.exit(1);
	}
	const shift = () => { arg = args.shift(); return arg; }
	const is_opt = () => arg[0] === "-";
	const is_opt_of = (s, l) => {
		if (!is_opt()) return false;
		if (s && arg.slice(0,1) === "-" && arg.slice(1) === s) return true;
		if (l && arg.slice(0,2) === "--" && arg.slice(2) === l) return true;
		return false;
	};
	const get_arg = () => {
		var opt = arg;
		var arg = shift();
		if (arg === undefined) usage("expected argument for " + opt);
		return arg;
	}
	const invalid = () => {
		if (is_opt()) {
			usage("invalid option " + arg);
		} else {
			usage("invalid positional argument '" + arg + "'");
		}
	}

	var verbose = false;
	var cmd;
	while (shift()) {
		if (is_opt()) {
			if (is_opt_of("v", "verbose")) {
				verbose = true;
			} else {
				invalid();
			}
		} else {
			cmd = arg;
			break;
		}
	}

	if (!cmd) usage("no command given, try 'help'");

	if (cmd === "help") {
		usage();
		const help_defaults = (list) => {
			for (var [msg, def] of list) {
				msg = "    " + msg;
				if (def) {
					if (typeof def === "object") def = def.join(",");
					msg += "  (default: " + def + ")";
				}
				console.log(msg);
			}
		}
		console.log();
		console.log("commands:");
		console.log("  help       - you're watching it!");
		console.log("  intro      - info on how to get started");
		console.log("  update     - update translations");
		help_defaults([
			["-L/--langs              list of languages to generate", update_defaults.langs],
			["-a/--append             append new translations to end of list (instead of relative insert)"],
			["-z/--fuzzyness          threshold for fuzzyness [0:1], 0 means 'none'", update_defaults.fuzzyness],
			["-s/--src-dirs           list of source directories to consider", update_defaults.src_dirs],
			["-e/--jsx-exts           list of extensions to consider", update_defaults.jsx_exts],
			["-T/--translations-file  where translations are [vcs/edit]", update_defaults.translations_file],
			["-I/--import-file        file you should import from React [vcs/edit]", update_defaults.import_file],
			["-M/--metadata-file      where metadata is stored [vcs/!edit]", update_defaults.metadata_file],
			["-C/--cache-file         cache for faster updates; safe to remove [!vcs/!edit]", update_defaults.cache_file],
			["  - 'vcs' means you should put this file under version control, '!vcs' means you should not"],
			["  - 'edit' means you can/should edit this file manually, '!edit' means you should not"],
			["-P/--babel-plugins    ", update_defaults.babel_plugins],
		]);
	} else if (cmd === "intro") {
		console.log();
		console.log("If you're using create-react-app, you must do the following:");
		console.log(" - eject your react app with 'npm run eject'; note that this is irreversible");
		console.log(" - change the babel preset from 'react-app' to 'traks/react-app' in your package.json");
		console.log();
		console.log("If you're not using create-react-app you need to figure out how to roll the");
		console.log("traks babel plugin into your build/compilation step; see traks/react-app.js for")
		console.log("inspiration. Traks will not work without this plugin.");
		console.log();
		console.log("After that, run traks update (with appropriate args); it will set up the files you need");
		console.log("and provide further information. E.g. /path/to/traks update --langs en,de,fr");
		console.log("Consider putting the 'traks update' command in a script of its own because you probably");
		console.log("wan to always run it with the same arguments. See 'traks help' for a list of accepted arguments.");
		console.log();
	} else if (cmd === "update") {
		var options = {...update_defaults};
		while (shift()) {
			if (is_opt()) {
				if (is_opt_of("L", "langs")) {
					options.langs = get_arg().split(",");
				} else if (is_opt_of("a", "append")) {
					options.append = true;
				} else if (is_opt_of("z", "fuzzyness")) {
					options.fuzzyness = parseFloat(get_arg());
					if (isNaN(options.fuzzyness)) usage("fuzzyness value is not a number");
				} else if (is_opt_of("s", "src-dirs")) {
					options.src_dirs = get_arg().split(",");
				} else if (is_opt_of("e", "jsx-exts")) {
					options.jsx_exts = get_arg().split(",");
				} else if (is_opt_of("T", "translations-file")) {
					options.translations_file = get_arg();
				} else if (is_opt_of("I", "import-file")) {
					options.import_file = get_arg();
				} else if (is_opt_of("M", "metadata-file")) {
					options.metadata_file = get_arg();
				} else if (is_opt_of("C", "cache-file")) {
					options.cache_file = get_arg();
				} else if (is_opt_of("P", "babel-plugins")) {
					options.babel_plugins = get_arg().split(",");
				} else {
					invalid();
				}
			} else {
				invalid();
			}
		}
		run_update(options);
	} else {
		usage("invalid command '" + cmd + "'; try 'help'");
	}
}

module.exports = {
	run,
}


const util = require("./util");
const fs = require('fs');
const build_env = process.env.BABEL_ENV || process.env.NODE_ENV;
const keep_children = build_env === 'development';
const bake_lang = process.env.TRAKS_BAKE_LANG;
const fallback_lang = process.env.TRAKS_FALLBACK_LANG;
const translations_file = process.env.TRAKS_TRANSLATIONS_FILE;

module.exports = (signature_normalizer_version) => {
	let try_langs;
	let translations;
	if (bake_lang) {
		if (!translations_file) {
			console.error("if TRAKS_BAKE_LANG is set, then TRAKS_TRANSLATIONS_FILE must also point at the translations file");
			process.exit(1);
		}
		// XXX babel-plugins should be the same as during 'traks update'...
		translations = new util.Translations(
			require('@babel/core'),
			['@babel/plugin-syntax-jsx/lib/index.js','@babel/plugin-proposal-object-rest-spread/lib/index.js'],
			translations_file);
		try_langs = [bake_lang];
		if (fallback_lang) try_langs.push(fallback_lang);
	}

	return (babel) => {
		const t = babel.types;
		return {
			visitor: {
				ExportDefaultDeclaration(path) {
					if (bake_lang && fs.realpathSync(path.hub.file.opts.filename) === fs.realpathSync(translations_file)) {
						util.bake_translations_export(babel, path, try_langs);
					}
				},

				JSXElement(path) {
					if (!util.is_translation_tag_node(path.node)) return;
					try {
						if (bake_lang) {
							util.bake(babel, path, translations, try_langs, signature_normalizer_version);
						} else {
							util.replace(babel, path, keep_children, signature_normalizer_version);
						}
					} catch(e) {
						if (e instanceof util.TraksError) {
							throw path.buildCodeFrameError(e.msg);
						} else {
							throw path.buildCodeFrameError(e);
						}
					}
				},

				StringLiteral(path) {
					const value = path.node.value;
					if (value === "TRAKS_COMPILE_TIME_MAGICK_CONST__IS_BAKED") {
						path.replaceWith(t.booleanLiteral(!!bake_lang));
					} else if (bake_lang && value === "TRAKS_COMPILE_TIME_MAGICK_CONST__LANG") {
						path.replaceWith(t.stringLiteral(bake_lang));
					}
				},
			},
		};
	};
};

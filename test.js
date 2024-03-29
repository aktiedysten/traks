#!/usr/bin/env node

const babel = require('@babel/core');
const lib = require('./lib');
const fs = require('fs');

function resolve_babel_ops(env, bake_lang, translations_file, signature_normalizer_version) {
	const imp = ["./react-app0", "./react-app1"][signature_normalizer_version];
	if (!imp) throw new Error("invalid signature_normalizer_version");

	// clear cache to force "re-require" of these files
	delete require.cache[require.resolve(imp)];
	delete require.cache[require.resolve("./react-app-ctor")];
	delete require.cache[require.resolve('@babel/preset-react')];

	process.env.NODE_ENV = env || '';
	process.env.TRAKS_BAKE_LANG = bake_lang || '';
	process.env.TRAKS_TRANSLATIONS_FILE = translations_file || '';
	const preset = { plugins: [require(imp)] }
	return {
		filename: "inline",
		presets: [require("@babel/preset-react"), preset]
	};
}

const resolve_babel_ops0 = (env, bake_lang, translations_file) => resolve_babel_ops(env, bake_lang, translations_file, 0);
const resolve_babel_ops1 = (env, bake_lang, translations_file) => resolve_babel_ops(env, bake_lang, translations_file, 1);

let T = {};

let React;
function mock_React() {
	React = {
		createElement: (type, props, children) => {
			React.type = type;
			React.props = props;
			React.children = children;
		}
	};
}

function assert(cond, msg) {
	if (!cond) throw new Error("assert() failed" + (msg ? (": "+msg) : ""));
}

function compare(a, b) {
	const ta = typeof a;
	const tb = typeof b;
	if (ta !== tb) return false;
	const t = ta;
	if (t === "object") {
		if (a.constructor !== b.constructor) return false;
		const ctor = a.constructor;
		if (ctor === Object) {
			for (let k in a) if (!compare(a[k], b[k])) return false;
			for (let k in b) if (!compare(a[k], b[k])) return false;
			return true;
		} else if (ctor === Array) {
			if (a.length !== b.length) return false;
			for (let i = 0; i < a.length; i++) if (!compare(a[i], b[i])) return false;
			return true;
		} else {
			throw new Error("unhandled object constructor: " + ctor);
		}
	} else {
		return a === b;
	}
}

function transform_test(code, babel_opts, assert_fn) {
	const tx = babel.transform(code, babel_opts);
	eval(tx.code);
	assert_fn({
		tx,
		assert_children_is(value) {
			assert(compare(React.children, value), 'React.children != ' + JSON.stringify(value) + ", actual value: " + JSON.stringify(React.children));
		},
		assert_prop_is(key, expected_value) {
			let actual_value = (React.props || {})[key];
			assert(compare(actual_value, expected_value), 'React.props[' + JSON.stringify(key) + '] != ' + JSON.stringify(expected_value) + ", actual value: " + JSON.stringify(actual_value));
		},
	});
}

let magic_is_baked, magic_lang;

const tests = [
	['simple translation (development)', () => {
		transform_test('<T>foo</T>', resolve_babel_ops1('development'), (t) => {
			assert(React.type === T);
			t.assert_children_is('foo');
			t.assert_prop_is('deps', []);
			t.assert_prop_is('k', 'e5410e122e8c');
		});
	}],

	['simple translation (production)', () => {
		transform_test('<T>foo</T>', resolve_babel_ops1('production'), (t) => {
			assert(React.type === T);
			t.assert_children_is(undefined);
			t.assert_prop_is('deps', []);
			t.assert_prop_is('k', 'e5410e122e8c');
		});
	}],

	['stability against whitespace changes in <T>-tags', () => {
		const common_key = '88b29c555c9c';
		const opt0 = resolve_babel_ops0('development');
		const opt1 = resolve_babel_ops1('development');

		const test = (code, opt, key) => {
			if (key === undefined) key = common_key;
			transform_test(code, opt, (t) => { t.assert_prop_is('k', key); });
		};

		// old and new normalizer should yield same key for simple tags
		// without newlines
		test('<T>foo bar</T>',    opt1);
		test('<T>foo bar</T>',    opt0);
		test('<T>foo   bar</T>',  opt1);
		test('<T>foo   bar</T>',  opt0);

		// old and new normalizer should yield /different/ keys when
		// containing newlines
		test('<T>foo\nbar</T>', opt1);
		test('<T>foo\nbar</T>', opt0, "a831df127868"); // <<< old v0 normalizer included newlines in signature, changing the hash

		// test that a bunch of "whitespace garbage" still doesn't
		// change the key with the new normalizer
		test('<T>foo\n\n\nbar</T>',               opt1);
		test('<T>foo\n \n \nbar</T>',             opt1);
		test('<T>  foo\n \n \nbar  </T>',         opt1);
		test('<T>  foo\n \r\n \t\n\rbar  </T>',   opt1);
	}],

	['magic constants', () => {
		transform_test('magic_is_baked = "TRAKS_COMPILE_TIME_MAGICK_CONST__IS_BAKED"', resolve_babel_ops1('development'), (t) => {
			assert(magic_is_baked === false);
		});

		const bake_opts = resolve_babel_ops1('development', 'zz', fs.realpathSync('test-fixtures/dummy-traks-translations.js'));

		transform_test('magic_is_baked = "TRAKS_COMPILE_TIME_MAGICK_CONST__IS_BAKED"', bake_opts, (t) => {
			assert(magic_is_baked === true);
		});

		transform_test('magic_lang = "TRAKS_COMPILE_TIME_MAGICK_CONST__LANG"', bake_opts, (t) => {
			assert(magic_lang === "zz");
		});
	}],

	['baking', () => {
		const bake_opts = resolve_babel_ops1('development', 'da', fs.realpathSync('test-fixtures/dummy-traks-translations.js'));

		// simple translations get inlined (see fixture above)
		transform_test('<T>foo</T>', bake_opts, (t) => {
			t.assert_children_is("foo-da");
			t.assert_prop_is('k', undefined);
			t.assert_prop_is('deps', undefined);
		});

		// complex translations are referenced by key (see fixture above)
		transform_test('<T>complex</T>', bake_opts, (t) => {
			t.assert_children_is(undefined);
			t.assert_prop_is('k', "15cffb8e9313");
			t.assert_prop_is('deps', []);
		});

		// simple translations referencing non-deps must also be
		// referenced by key
		transform_test('FOO="some dep";<T>almost too simple {FOO}</T>', bake_opts, (t) => {
			t.assert_children_is(undefined);
			t.assert_prop_is('k', "00f9c09179a5");
			t.assert_prop_is('deps', ["some dep"]);
		});
	}],

	['baking of traks-translations.js', () => {
		const filename = 'test-fixtures/dummy-traks-translations.js';
		const code = fs.readFileSync(filename).toString();
		let export_path;
		const tx = babel.transform(code, {
			filename: filename,
			babelrc: false,
			plugins: [
				'@babel/plugin-syntax-jsx/lib/index.js',
				'@babel/plugin-proposal-object-rest-spread/lib/index.js',
				function (babel) {
					return {
						visitor: {
							ExportDefaultDeclaration(path) {
								lib.bake_translations_export(babel, path, ["da"]);
								export_path = path;
							}
						}
					};
				}
			]
		});

		if (!export_path) assert(false, "no export path found");

		let key_set = {};
		let key_type = {};
		for (const prop of export_path.node.declaration.properties) {
			key_set[prop.key.value] = true;
			key_type[prop.key.value] = prop.value.body.type;
		}

		assert(!key_set["e5410e122e8c"], "simple expression translations must not be in the translations file (should be inlined)");
		assert(key_set["15cffb8e9313"], "complex block statement translation wasn't found in translations file (implies it was inlined?)");
		assert(key_set["00f9c09179a5"], "simple expression translation with local references wasn't found in translations file (cannot be inlined)");

		assert(key_type["15cffb8e9313"] === "BlockStatement");
		assert(key_type["00f9c09179a5"] === "JSXElement");
	}],

	['key attribute is passed as-is', () => {
		transform_test('<T key={5}>foo</T>', resolve_babel_ops1('development'), (t) => {
			assert(React.type === T);
			t.assert_children_is('foo');
			t.assert_prop_is('deps', []);
			t.assert_prop_is('k', 'e5410e122e8c');
			t.assert_prop_is('key', 5);
		});

		const bake_opts = resolve_babel_ops1('development', 'da', fs.realpathSync('test-fixtures/dummy-traks-translations.js'));
		transform_test('<T key={42}>foo</T>', bake_opts, (t) => {
			t.assert_children_is("foo-da");
			t.assert_prop_is('k', undefined);
			t.assert_prop_is('deps', undefined);
			t.assert_prop_is('key', 42);
		});
	}],

	['deps', () => {
		transform_test('<T>{42}</T>', resolve_babel_ops1('development'), (t) => {
			t.assert_prop_is('deps', []);
		});

		transform_test('FOO=420;<T>{FOO}</T>', resolve_babel_ops1('development'), (t) => {
			t.assert_prop_is('deps', [420]);
		});

		transform_test('A=1;B=2;C=3;<T>{A}{B}{C}</T>', resolve_babel_ops1('development'), (t) => {
			t.assert_prop_is('deps', [1,2,3]);
		});

		transform_test('A="a";B="b";C="c";<T>{C}{B}{A}{B}{C}</T>', resolve_babel_ops1('development'), (t) => {
			t.assert_prop_is('deps', ["a", "b", "c"]);
		});

		transform_test('A={B:{C:420}};<T>{A.B.C}</T>', resolve_babel_ops1('development'), (t) => {
			t.assert_prop_is('deps', [{B:{C:420}}]);
		});

		transform_test('<T><span>hey</span></T>', resolve_babel_ops1('development'), (t) => {
			t.assert_prop_is('deps', []);
		});

		transform_test('A=()=>"foo";<T><A/></T>', resolve_babel_ops1('development'), (t) => {
			t.assert_prop_is('deps', [A]);
		});

		transform_test('A=42;B=420;<T deps={[B]}>{A}</T>', resolve_babel_ops1('development'), (t) => {
			t.assert_prop_is('deps', [42,420]);
		});

		transform_test('BAR=666;<T><div xyzzy={{foooz:BAR}}></div></T>', resolve_babel_ops1('development'), (t) => {
			t.assert_prop_is('deps', [666]);
		});

		let ex;
		try {
			transform_test('<T>{this.state}</T>', resolve_babel_ops1('development'));
		} catch (e) {
			ex = e;
		}
		if (!ex) {
			assert(false, "expected to throw");
		} else {
			if (!ex.toString().match(/'this' is not allowed/)) {
				throw ex;
			}
		}
	}],
];

for (const [name, test] of tests) {
	mock_React();
	console.log("TEST", name);
	test();
}

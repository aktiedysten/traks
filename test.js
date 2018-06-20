const babel = require('babel-core');
const util = require('./util');
const fs = require('fs');

function require_force(module) {
	const path = require.resolve(module);
	delete require.cache[path];
	return require(module);
}

function require_preset(env, bake_lang, translations_file) {
	delete require.cache[require.resolve('./react-app')];
	delete require.cache[require.resolve('babel-preset-react-app')];
	process.env.NODE_ENV = env || '';
	process.env.TRAKS_BAKE_LANG = bake_lang || '';
	process.env.TRAKS_TRANSLATIONS_FILE = translations_file || '';
	return require('./react-app');
}

function babel_opts(env, bake_lang, translations_file) {
	const preset = require_preset(env, bake_lang, translations_file);
	return {
		filename: "inline",
		presets: [preset]
	};
}

var T = {};

var React = {
	createElement: (type, props, children) => {
		React.type = type;
		React.props = props;
		React.children = children;
	}
};

function assert(cond, msg) {
	if (msg) {
		msg = ": " + msg;
	} else {
		msg = "";
	}
	if (!cond) throw new Error("assert() failed" + msg);
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
			for (var k in a) if (!compare(a[k], b[k])) return false;
			for (var k in b) if (!compare(a[k], b[k])) return false;
			return true;
		} else if (ctor === Array) {
			if (a.length !== b.length) return false;
			for (var i = 0; i < a.length; i++) if (!compare(a[i], b[i])) return false;
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
		assert_prop_is(key, value) {
			assert(compare(React.props[key], value), 'React.props[' + JSON.stringify(key) + '] != ' + JSON.stringify(value) + ", actual value: " + JSON.stringify(React.props[key]));
		},
	});
}

var magic_is_baked, magic_lang;

const tests = [
	['simple translation (development)', () => {
		transform_test('<T>foo</T>', babel_opts('development'), (t) => {
			assert(React.type === T);
			t.assert_children_is('foo');
			t.assert_prop_is('deps', []);
			t.assert_prop_is('k', 'e5410e122e8c');
		});
	}],

	['simple translation (production)', () => {
		transform_test('<T>foo</T>', babel_opts('production'), (t) => {
			assert(React.type === T);
			t.assert_children_is(undefined);
			t.assert_prop_is('deps', []);
			t.assert_prop_is('k', 'e5410e122e8c');
		});
	}],

	['magic constants', () => {
		transform_test('magic_is_baked = "TRAKS_COMPILE_TIME_MAGICK_CONST__IS_BAKED"', babel_opts('development'), (t) => {
			assert(magic_is_baked === false);
		});

		const bake_opts = babel_opts('development', 'zz', fs.realpathSync('test-fixtures/dummy-traks-translations.js'));

		transform_test('magic_is_baked = "TRAKS_COMPILE_TIME_MAGICK_CONST__IS_BAKED"', bake_opts, (t) => {
			assert(magic_is_baked === true);
		});

		transform_test('magic_lang = "TRAKS_COMPILE_TIME_MAGICK_CONST__LANG"', bake_opts, (t) => {
			assert(magic_lang === "zz");
		});
	}],

	['baking', () => {
		const bake_opts = babel_opts('development', 'da', fs.realpathSync('test-fixtures/dummy-traks-translations.js'));

		/* simple translations get inlined (see fixture above) */
		transform_test('<T>foo</T>', bake_opts, (t) => {
			t.assert_children_is("foo-da");
			t.assert_prop_is('k', undefined);
			t.assert_prop_is('deps', undefined);
		});

		/* complex translations are referenced by key (see fixture above) */
		transform_test('<T>complex</T>', bake_opts, (t) => {
			t.assert_children_is(undefined);
			t.assert_prop_is('k', "15cffb8e9313");
			t.assert_prop_is('deps', []);
		});

		/* simple translations referencing non-deps must also be
		 * referenced by key */
		transform_test('FOO="some dep";<T>almost too simple {FOO}</T>', bake_opts, (t) => {
			t.assert_children_is(undefined);
			t.assert_prop_is('k', "00f9c09179a5");
			t.assert_prop_is('deps', ["some dep"]);
		});
	}],

	['baking of traks-translations.js', () => {
		const filename = 'test-fixtures/dummy-traks-translations.js';
		const code = fs.readFileSync(filename).toString();
		var export_path;
		const tx = babel.transform(code, {
			filename: filename,
			babelrc: false,
			plugins: [
				'babel-plugin-syntax-jsx',
				'babel-plugin-syntax-object-rest-spread',
				'babel-plugin-syntax-class-properties',
				function (babel) {
					return {
						visitor: {
							ExportDefaultDeclaration(path) {
								util.bake_translations_export(babel, path, "da");
								export_path = path;
							}
						}
					};
				}
			]
		});

		if (!export_path) assert(false, "no export path found");

		var key_set = {};
		var key_type = {};
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
		transform_test('<T key={5}>foo</T>', babel_opts('development'), (t) => {
			assert(React.type === T);
			t.assert_children_is('foo');
			t.assert_prop_is('deps', []);
			t.assert_prop_is('k', 'e5410e122e8c');
			t.assert_prop_is('key', 5);
		});

		const bake_opts = babel_opts('development', 'da', fs.realpathSync('test-fixtures/dummy-traks-translations.js'));
		transform_test('<T key={42}>foo</T>', bake_opts, (t) => {
			t.assert_children_is("foo-da");
			t.assert_prop_is('k', undefined);
			t.assert_prop_is('deps', undefined);
			t.assert_prop_is('key', 42);
		});
	}],

	['deps', () => {
		transform_test('<T>{42}</T>', babel_opts('development'), (t) => {
			t.assert_prop_is('deps', []);
		});

		transform_test('FOO=420;<T>{FOO}</T>', babel_opts('development'), (t) => {
			t.assert_prop_is('deps', [420]);
		});

		transform_test('A=1;B=2;C=3;<T>{A}{B}{C}</T>', babel_opts('development'), (t) => {
			t.assert_prop_is('deps', [1,2,3]);
		});

		transform_test('A="a";B="b";C="c";<T>{C}{B}{A}{B}{C}</T>', babel_opts('development'), (t) => {
			t.assert_prop_is('deps', ["a", "b", "c"]);
		});

		transform_test('A={B:{C:420}};<T>{A.B.C}</T>', babel_opts('development'), (t) => {
			t.assert_prop_is('deps', [{B:{C:420}}]);
		});

		transform_test('<T><span>hey</span></T>', babel_opts('development'), (t) => {
			t.assert_prop_is('deps', []);
		});

		transform_test('A=()=>"foo";<T><A/></T>', babel_opts('development'), (t) => {
			t.assert_prop_is('deps', [A]);
		});

		transform_test('A=42;B=420;<T deps={[B]}>{A}</T>', babel_opts('development'), (t) => {
			t.assert_prop_is('deps', [42,420]);
		});

		transform_test('BAR=666;<T><div xyzzy={{foooz:BAR}}></div></T>', babel_opts('development'), (t) => {
			t.assert_prop_is('deps', [666]);
		});

		var ex;
		try {
			transform_test('<T>{this.state}</T>', babel_opts('development'));
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
	console.log("TEST", name);
	test();
}

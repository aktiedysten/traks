#!/usr/bin/env bash

set -e

if [ -z "$2" ] ; then
	echo "Usage: $0 <traks-source> <name>"
	echo "For <traks-source> use:"
	echo "   traks                  Install public version"
	echo "   /path/to/traks/git     Install local version"
	exit 1
fi

traks_source="$1"
name="$2"

npx create-react-app $name
cd $name

# Traks relies heavily on its Babel/compiler plugin, which cannot be enabled in
# a "vanilla create-react-app". `react-app-rewired` and `customize-cra` are
# used to allow the necessary customization (an alternative approch is `npm run
# eject`)
npm install --save-dev react-app-rewired customize-cra cross-env


# Fix package.json; changing "react-scripts" => "react-app-rewired" is a
# requirement of `react-app-rewired`
sed -i 's/react-scripts start/cross-env PORT=63000 react-app-rewired start/g' package.json
sed -i 's/react-scripts build/react-app-rewired build/g' package.json
sed -i 's/react-scripts test/react-app-rewired test/g' package.json


# Install traks (hopefully; argument is not validated)
npm install --save $traks_source



cat <<HERE > config-overrides.js
const {
	override,
	getBabelLoader,
	useBabelRc,
} = require("customize-cra");

const disableBabelLoaderCacheThankYou = () => (config) => {
	const loader = getBabelLoader(config);
	loader.options.cacheDirectory = false;
	return config;
};

const babelBrainSurgery = () => (config) => {
	// The standard way of adding Babel plugins/presets is via
	// customize-cra's addBabelPreset() and addBabelPlugin(), but none of
	// these approaches play nice with traks. I also tried
	// prepending/appending traks as a preset/plugin (all 4 combinations)
	// instead of overwriting the preset/plugins arrays like I do here. All
	// these approaches end up doing "weird internal AST rewrites" before
	// my traks plugin runs (it triggers the ThisExpression guard in
	// util.js; removing THAT simply moves the problem elsewhere and makes
	// it even harder to debug)

	// However, overwriting these arrays, setting them to what I think they
	// should be, seems to work

	const loader = getBabelLoader(config);

	// looking for named asset import plugin; it has complex arguments, so
	// I'm not adding it as-is as a string
	let named_asset_import;
	for (const p of loader.options.plugins) {
		if (typeof p === "string") continue;
		if (p[0].indexOf("named-asset-import") !== -1) {
			named_asset_import = p;
			break;
		}
	}

	loader.options.presets = [];
	loader.options.plugins = [
		// https://babeljs.io/docs/en/babel-preset-react says the
		// preset consists of these plugins:
		"@babel/plugin-syntax-jsx",
		"@babel/plugin-transform-react-jsx",
		"@babel/plugin-transform-react-display-name",
	];

	if (process.env.NODE_ENV !== "production") {
		loader.options.plugins.push("react-refresh/babel.js");
	}

	if (named_asset_import) loader.options.plugins.push(named_asset_import);
	loader.options.plugins.push("traks/react-app");

	return config;
};

module.exports = override(
	disableBabelLoaderCacheThankYou(),
	babelBrainSurgery(),
);
HERE






cat <<HERE > src/traks.js
import React from "react";
import translations from "./traks-translations";

let m;
if ("TRAKS_COMPILE_TIME_MAGICK_CONST__IS_BAKED") {
        let setup = require('traks/setup-baked');
        m = setup({
                translations,
                lang: "TRAKS_COMPILE_TIME_MAGICK_CONST__LANG",
                set_lang: (lang) => { console.log(["TODO set lang", lang]); }
        });
} else {
        let setup = require('traks/setup');
        const TranslationMissing = (props) => (
                <div style={{ backgroundColor: "#f0f", color: "#0f0" }}>
                        {props.children || null}
                </div>
        );

        m = setup({
                translations,
                default_lang: "en",
                translation_missing_component: TranslationMissing,
        });
}

const { T, TraksProvider, TraksConsumer } = m;
export { T, TraksProvider, TraksConsumer };
HERE






# Demo translation file
cat <<HERE > src/traks-translations.js
import React from "react";
/* eslint-disable import/no-anonymous-default-export */
const O = React.Fragment;
export default {
	"c4b488637b50": {
		"en": (n) => {
			switch (n) {
			case 0:  return <O>You have no unread notifications</O>;
			case 1:  return <O>You have one unread notification</O>;
			default: return <O>You have {n} unread notifications</O>;
			}
		},
		"da": (n) => {
			switch (n) {
			case 0:  return <O>Du har ingen ulæste notifikationer</O>;
			case 1:  return <O>Du har én ulæst notifikation</O>;
			default: return <O>Du har {n} ulæste notifikationer</O>;
			}
		},
		"de": (n) => {
			switch (n) {
			case 0:  return <O>Sie haben keine ungelesenen Benachrichtigungen</O>;
			case 1:  return <O>Sie haben eine ungelesene Benachrichtigung</O>;
			default: return <O>Sie haben {n} ungelesene Benachrichtigungen</O>;
			}
		},
	},

	"b6d4673d19f2": {
		"en": () => <O>Hello world</O>,
		"da": () => <O>Hej verden</O>,
		"de": () => <O>Hallo Welt</O>,
	},
}
HERE





# Script for updating translations
cat <<HERE > update-translations.js
#!/usr/bin/env node
let tool = require("traks/tool");
tool.run_update(require("./traks-config"));
HERE
chmod +x update-translations.js




# Traks configuration; languages, directories, etc
cat <<HERE > traks-config.js
module.exports = {
	langs: ["en", "da", "de"],
	src_dirs: ["src"],
	jsx_exts: ["js"],
	append: false,

	translations_file: "./src/traks-translations.js",
	import_file: "./src/traks.js",

	babel_plugins: [
		"@babel/plugin-syntax-jsx/lib/index.js",
		"@babel/plugin-proposal-object-rest-spread/lib/index.js",
	],

	tab: "\t",
}
HERE



# Default create-react-app App replaced with translation demo, including
# language selection
mv src/App.js src/App.js.orig
cat <<HERE > src/App.js
import React, { useState } from 'react';
import './App.css';
import { T, TraksConsumer } from './traks';

function LangSelectInner(props) {
  let [ value, set_value ] = useState("en");
  let on_change = (e) => {
    let lang = e.target.value;
    set_value(lang);
    props.set_lang(lang);
  }
  return (
    <select value={value} onChange={on_change}>
      <option value="en">English</option>
      <option value="da">Danish</option>
      <option value="de">Deutsch</option>
    </select>
  );
}

function LangSelect(props) {
  return <TraksConsumer><LangSelectInner/></TraksConsumer>;
}

function NonTrivialTranslation(props) {
  let n = props.n;
  return <div><T>You have {n} unread notifications</T></div>;
}

function App() {
  let ns = [];
  for (let i = 0; i < 4; i++) ns.push(<NonTrivialTranslation key={i} n={i}/>);
  return (
    <div className="App">
      <header className="App-header">
        <LangSelect/>
        <T>Hello world</T>
        {ns}
      </header>
    </div>
  );
}

export default App;
HERE





# App must be wrapped in <TraksProvider> in order for traks to work. Default
# language is also set here.
mv src/index.js src/index.js.orig
cat <<HERE > src/index.js
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { TraksProvider } from './traks';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <TraksProvider lang="en">
      <App />
    </TraksProvider>
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
HERE





cat <<HERE > bake-build.sh
#!/usr/bin/env bash
if [ -z "\$1" ] ; then
	echo "Usage: \$0 <lang>"
	exit 1
fi
TRAKS_BAKE_LANG=\$lang TRAKS_FALLBACK_LANG=en TRAKS_TRANSLATIONS_FILE=src/traks-translations.js npm run build
HERE
chmod +x bake-build.sh


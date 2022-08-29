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

npx create-expo-app $name
cd $name


# install web...
npx expo install react-native-web react-dom @expo/webpack-config


# Install traks (hopefully; argument is not validated)
npm install --save $traks_source



cat <<HERE > babel.config.js
module.exports = function (api) {
	api.cache(true);
	return {
		presets: ["traks/expo-preset", "babel-preset-expo"],
	};
};
HERE




cat <<HERE > traks.js
import React from "react";
import translations from "./traks-translations";
import { Text } from "react-native";
import setup from "traks/setup";

const TranslationMissing = (props) => (
        <Text style={{ backgroundColor: "#f0f", color: "#ff0" }}>
                {props.children || null}
        </Text>
);

const { T, TraksProvider, TraksConsumer } = setup({
        translations,
        default_lang: "da",
        translation_missing_component: TranslationMissing,
});

export { T, TraksProvider, TraksConsumer };
HERE




# Demo translation file
cat <<HERE > traks-translations.js
import React from "react";
import { Text } from "react-native";
const O = Text;
/* eslint-disable import/no-anonymous-default-export */
export default {
	"4d490f523a4d": {
		"en": () => <O>Hello World!</O>,
		"da": () => <O>Hej Verden!</O>,
		"de": () => <O>Hallo Welt!</O>,
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
	src_dirs: ["."],
	exclude_files: [".eslintrc.js", "babel.config.js", "traks.js", "traks-translations.js", "update-translations.js"],
	exclude_dirs: ["node_modules", ".git", ".expo"],
	jsx_exts: ["js"],
	append: false,

	translations_file: "./traks-translations.js",
	import_file: "./traks.js",

	babel_plugins: [
		"@babel/plugin-syntax-jsx/lib/index.js",
		"@babel/plugin-proposal-object-rest-spread/lib/index.js",
	],

	tab: "\t",
}
HERE




mv App.js App.js.orig
cat <<HERE > App.js
import React, { useState} from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, Button } from 'react-native';
import { T, TraksProvider, TraksConsumer } from "./traks";

function LangSelect(props) {
	const P = (lang) => () => props.set_lang(lang);
	return (
		<>
			<Text>Set language ({props.lang}): </Text>
			<Button title="en" onPress={P("en")}/>
			<Button title="da" onPress={P("da")}/>
			<Button title="de" onPress={P("de")}/>
		</>
	);
}

function Main(props) {
	return <T>Hello World!</T>;
}

export default function App() {
  return (
    <View style={styles.container}>
      <TraksProvider lang="en">
        <TraksConsumer><LangSelect/></TraksConsumer>
        <Main/>
        <StatusBar style="auto" />
      </TraksProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
HERE



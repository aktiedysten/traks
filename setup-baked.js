const React = require('react');
const { renderToStaticMarkup } = require("./renderToStaticMarkup")

module.exports = function(opts) {
	const T = function (props) {
		const key = props.k;
		if (key) {
			return opts.translations[key].apply(null, props.deps);
		} else {
			return props.children;
		}
	};

	let TraksProvider = function(props) {
		return props.children;
	}

	const TraksConsumer = function (props) {
		const render_static = function (element) {
			return renderToStaticMarkup(element);
		};
		return React.cloneElement(
			props.children,
			{
				lang: opts.lang,
				set_lang: opts.set_lang,
				render_static: render_static,
			}
		);
	};

	return { T: T, TraksProvider: TraksProvider, TraksConsumer: TraksConsumer };
}

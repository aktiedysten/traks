const React = require('react');
const ReactDOMServer = require('react-dom/server');

module.exports = function(opts) {
	var ctx_value = {
		translation_missing_component: opts.translation_missing_component,
		translations: opts.translations
	};

	const ctx = React.createContext();

	const T = function (props) {
		return React.createElement(
			ctx.Consumer,
			{},
			function (value) {
				if (value === undefined) {
					throw new Error("<T> tag not used inside <TraksProvider/>");
				}
				const key = props.k;
				const lang = value.lang;
				if (value.translations[key] && value.translations[key][lang]) {
					return value.translations[key][lang].apply(null, props.deps);
				} else if (value.translation_missing_component) {
					return React.createElement(value.translation_missing_component, {}, props.children);
				} else {
					return props.children;
				}
			}
		);
	};

	var TraksProvider = function(props) {
		React.Component.call(this, props);
		this.state = {lang: props.lang || opts.default_lang}
	}
	TraksProvider.prototype = Object.create(React.Component.prototype);
	TraksProvider.prototype.constructor = TraksProvider;
	TraksProvider.prototype.render = function () {
		const value = {
			translation_missing_component: opts.translation_missing_component,
			translations: opts.translations,
			lang: this.state.lang,
			set_lang: (function (lang) {
				this.setState({lang: lang});
			}).bind(this)
		}
		return React.createElement(ctx.Provider, {value: value}, this.props.children);
	};

	const TraksConsumer = function (props) {
		return React.createElement(
			ctx.Consumer,
			{},
			function (value) {
				if (value === undefined) {
					throw new Error("<TraksConsumer> tag not used inside <TraksProvider/>");
				}
				const render_static = function (element) {
					return ReactDOMServer.renderToStaticMarkup(
						React.createElement(TraksProvider, {value: value, lang: value.lang}, element)
					);
				};
				return React.cloneElement(
					props.children,
					{
						lang: value.lang,
						set_lang: value.set_lang,
						render_static: render_static
					}
				);
			}
		);
	};

	return { T: T, TraksProvider: TraksProvider, TraksConsumer: TraksConsumer };
}

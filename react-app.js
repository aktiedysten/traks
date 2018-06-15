const react_app = require('babel-preset-react-app');
const util = require('./util');

const traksform = (babel) => {
	var env = process.env.BABEL_ENV || process.env.NODE_ENV;
	const keep_children = env === 'development';
	/* TODO underscore-prefixed fields should be removed from
	 * traks-translations.js if env != 'development'... how to do that? */
	return {
		visitor: {
			JSXElement(path) {
				if (!util.is_translation_tag_node(path.node)) return;
				try {
					util.replace(babel, path, keep_children);
				} catch(e) {
					if (e instanceof util.TraksError) {
						throw path.buildCodeFrameError(e.msg);
					} else {
						throw path.buildCodeFrameError(e);
					}
				}
			}
		}
	}
};
module.exports = { ...react_app, plugins: [traksform, ...react_app.plugins] };


const util = require("./util");

// eslint-disable-next-line no-unused-vars
module.exports = function (api, options = {}) {
	const keep_children = true;
	const traksform = (babel) => {
		return {
			visitor: {
				JSXElement(path) {
					if (!util.is_translation_tag_node(path.node)) return;
					util.replace(babel, path, keep_children);
				},
			},
		};
	};
	return { plugins: [traksform] };
};

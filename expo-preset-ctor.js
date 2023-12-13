const util = require("./util");

// eslint-disable-next-line no-unused-vars

module.exports = (signature_normalizer_version) => {
	return function (api, options = {}) {
		const keep_children = true;
		const traksform = (babel) => {
			return {
				visitor: {
					JSXElement(path) {
						if (!util.is_translation_tag_node(path.node)) return;
						util.replace(babel, path, keep_children, signature_normalizer_version);
					},
				},
			};
		};
		return { plugins: [traksform] };
	};
}

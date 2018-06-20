function O(props) { return props.children || []; }

function almost_simple_enough_but_this_reference_prevents_inlining() {
	return "PHEW";
}

export default {
	"e5410e122e8c": {
		"da": () => <O>foo-da</O>,
	},

	"15cffb8e9313": {
		"da": () => {
			const complex_function_body = "complex_function_body";
			return <O>{complex_function_body}</O>;
		},
	},

	"00f9c09179a5": {
		"da": (FOO) => <O>{almost_simple_enough_but_this_reference_prevents_inlining()}{FOO}</O>,
	},
}

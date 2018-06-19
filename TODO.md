 - BUG: dependency analysis fails for a number of cases:
    - `<T><div xyzzy={{foo:42}}/></T>` - it thinks `foo` is a dependency
    - `<T><div xyzzy={foo.bar}/></T>` - it also thinks `bar` is a dependency
    - `<T><div xyzzy={this.state.xyzzy}/></T>` - it sorta-correctly finds
      `this` as a dep, but it doesn't work (I need to rename it, or disallow
      `this`)
 - TODO would be nice with some automatic tests

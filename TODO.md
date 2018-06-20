 - BUG: when baking, "expression translations", like `()=><O>translation</O>`
   are inlined (as opposed to "block statement translations", like
   `()=>{return <O>translation</O>}`, which are referenced by translation key),
   so when an expression translation references local identifiers in
   `traks-translations.js`, the inlining causes run-time errors because the
   identifiers are not available in the local scope. The best fix would be to
   improve the code that determines whether a translation can be inlined or
   not, i.e. it should detect non-dep identifiers.
 - TODO: fuzzy string matching; `gettext` has this; the idea is that if you change
   `<T>Hello world</T>` to `<T>Hello world!</T>`, then `traks update` should detect
   that these are very similar and then offer to migrate it. Currently, it simply
   marks the old one as deleted, and adds the new one.
 - TODO: improved tests

 - TODO fuzzyness
 - improved tests
 - BUG: when baking, "expression translations", like `()=><O>translation</O>`
   are inlined )as opposed to "block statement translations", like
   `()=>{return <O>translation</O>}`, which are referenced by translation key),
   so when an expression translation references local identifiers in
   `traks-translations.js`, the inlining causes run-time errors because the
   identifiers are not available in the local scope. the best fix would be to
   improve the code that determines whether a translation can be inlined or
   not, i.e. it should detect non-dep identifiers

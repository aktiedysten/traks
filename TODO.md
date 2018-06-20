 - TODO: fuzzy string matching; `gettext` has this; the idea is that if you change
   `<T>Hello world</T>` to `<T>Hello world!</T>`, then `traks update` should detect
   that these are very similar and then offer to migrate it. Currently, it simply
   marks the old one as deleted, and adds the new one.
 - TODO: improved tests

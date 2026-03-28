# @keychord/config

## Usage

```ts
import { defineConfig } from '@keychord/config';

export default defineConfig({
  dts: false, // set to true to generate `.d.ts` files in js/
  vendor: [
    // an array of chord packages used in this package
  ]
});
```

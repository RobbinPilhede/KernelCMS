# @kernel/visual-editing

A tiny, framework-agnostic SDK that turns your own frontend into a click-to-edit
surface inside the KernelCMS admin's live-preview iframe.

## React

```ts
import { useKernelPreview, kernelEditable } from '@kernel/visual-editing/react'

const data = useKernelPreview(initialData)
return <h1 {...kernelEditable('hero.0.heading')}>{data.hero[0].heading}</h1>
```

`useKernelPreview` returns `initialData` until the editor posts live data (and
in production, where there is no parent editor). Spread `kernelEditable(path)`
onto any element to make it click-to-edit; the path is a dot-path into your data.

## Framework-agnostic

```ts
import { connectVisualEditing, kernelEditable } from '@kernel/visual-editing'

const preview = connectVisualEditing()
preview.subscribe((data) => render(data))
// later: preview.destroy()
```

`connectVisualEditing` is a no-op outside an iframe, so it is safe to call
unconditionally on the client.

## Security

This SDK runs inside the preview iframe. Inbound `kernel-preview` data is applied
only when it comes from `window.parent`; pass `allowedOrigins` to additionally
pin the editor's origin:

```ts
connectVisualEditing({ allowedOrigins: ['https://admin.example.com'] })
```

The hosting admin validates the iframe's origin on its side too. Outbound
select/hover/ready signals carry only a dot-path string; set `parentOrigin` to
the admin origin to keep even those private. The SDK never posts document content
back to the editor and never renders received data itself.

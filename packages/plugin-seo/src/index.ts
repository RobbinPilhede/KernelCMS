/**
 * @kernel/plugin-seo — adds SEO meta fields (and optional auto-generation) to
 * selected collections. A first-party demonstration of the plugin SDK: it is an
 * ordinary config transformer with no privileged access. Parity with Payload's
 * @payloadcms/plugin-seo, but it ships real schema through the same migration path.
 */
import { definePlugin, effectiveFields } from '@kernel/core'
import type { AnyField, CollectionConfig, HookArgs, Row } from '@kernel/core'

export interface SeoPluginOptions {
  /** Collection slugs to add SEO fields to. */
  collections: string[]
  /** Source field whose value seeds `meta_title` when it is left blank. */
  generateTitleFrom?: string
  /** Source field whose value seeds `meta_description` when it is left blank. */
  generateDescriptionFrom?: string
  /** Max length enforced on `meta_description` (search engines truncate ~160). */
  descriptionMaxLength?: number
}

const SEO_TAB = 'SEO'

export const seoPlugin = definePlugin<SeoPluginOptions>((options) => ({
  name: 'kernel/seo',
  version: '0.1.0',
  setup: (ctx) =>
    ctx.extend.collections(options.collections, (collection: CollectionConfig) => {
      const seoFields: AnyField[] = [
        {
          name: 'meta_title',
          type: 'text',
          maxLength: 70,
          admin: { tab: SEO_TAB, description: 'Title for search results and social cards (≤70 chars).' },
        },
        {
          name: 'meta_description',
          type: 'textarea',
          maxLength: options.descriptionMaxLength ?? 160,
          admin: { tab: SEO_TAB, description: 'Summary shown under the title in search results.' },
        },
      ]
      // Don't double-add if the plugin (or the user) already declared these.
      const existing = new Set(effectiveFields(collection.fields).map((f) => f.name))
      const toAdd = seoFields.filter((f) => !existing.has(f.name))

      const fill = (args: HookArgs & { data: Row }): Row => {
        const data = { ...args.data }
        if (!data.meta_title && options.generateTitleFrom) {
          const src = data[options.generateTitleFrom]
          if (typeof src === 'string' && src) data.meta_title = src.slice(0, 70)
        }
        if (!data.meta_description && options.generateDescriptionFrom) {
          const src = data[options.generateDescriptionFrom]
          if (typeof src === 'string' && src) data.meta_description = src.slice(0, options.descriptionMaxLength ?? 160)
        }
        return data
      }

      return {
        ...collection,
        fields: [...collection.fields, ...toAdd],
        hooks: {
          ...collection.hooks,
          beforeChange: [...(collection.hooks?.beforeChange ?? []), fill],
        },
      }
    }),
}))

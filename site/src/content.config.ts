import { defineCollection } from 'astro:content'
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders'
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema'

export const collections = {
    docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
    // Starlight always reads this collection (UI strings); src/content/i18n/en.json overrides none of them for now,
    // but without the collection every build warns 'The collection "i18n" does not exist or is empty'.
    i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
}

# glowing-palm-tree

Four Expo applications share delivery, admin, and provider services for Ammu Sammu and Konkan Fine Dine.

| Workspace | Audience |
| --- | --- |
| `ammu-sammu-customer` | Ammu Sammu customers |
| `ammu-sammu-admin` | Ammu Sammu administrators |
| `konkan-fine-dine-customer` | Konkan Fine Dine customers |
| `konkan-fine-dine-admin` | Konkan Fine Dine administrators |

Use Node 24 and `npm ci`, then `npm run app -- ammu-sammu-customer web` to run an app locally. Run `npm run check` for repository checks or `npm run build:web --workspace ammu-sammu-customer` to export one web app. Substitute another workspace from the table as needed.

See [release setup](docs/RELEASE.md) for Vercel, provider configuration, native builds, and launch gates. Provider projects, credentials, verified delivery areas, and production deployments still require operator setup. See the [team workflow](.agents/skills/team-lead/SKILL.md) for issue approval and review.

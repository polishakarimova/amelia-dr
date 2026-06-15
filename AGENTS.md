# AGENTS.md — правила для Codex в проекте «Повод»

## Главный принцип

«Повод» — сервис, где организатор создает красивую карточку праздника в одной ссылке: дата, время, место, карта, приглашение, пожелания, список подарков, ссылки, картинки, цены и бронь подарков гостями, чтобы не было дублей.

Главная продуктовая метафора:

> хаос в переписках -> одна ссылка -> красивый собранный праздник.

Визуальный стиль: soft festive invitation UI, warm celebration card system, one-link celebration organizer. Это не SaaS, не CRM, не админка и не детский мультяшный сервис.

## Обязательные правила

- Перед любыми UI-изменениями читать документы из `docs/design`.
- Перед дизайн-правками проверять папку `docs/design/assets/logo-reference`.
- Использовать только approved SVG-логотип из `docs/design/assets/logo-reference/gift_arch_symbol_exact_v2.svg`.
- Не перерисовывать approved logo и не менять его форму.
- Не заменять логотип на lucide/shadcn/random icon.
- Не использовать старый логотип из бренд-коллажа как основной.
- Не делать шаблонный SaaS.
- Не делать CRM/админку.
- Не делать пустые белые карточки без характера.
- Не менять бренд-стиль без причины.
- Все экраны должны соответствовать brand guide и UI rules.
- Перед завершением дизайн-задачи проводить self-review по rubric.
- Если экран набирает меньше 90/100 по rubric, дорабатывать.

## Обязательные дизайн-документы

- `docs/design/POVOD_BRAND_GUIDE.md`
- `docs/design/POVOD_UI_RULES.md`
- `docs/design/POVOD_REFERENCE_ANALYSIS.md`
- `docs/design/POVOD_DESIGN_QUALITY_RUBRIC.md`
- `docs/design/POVOD_SELF_REVIEW_PROCESS.md`
- `docs/design/POVOD_DO_NOT_REPEAT.md`
- `docs/design/POVOD_IMPLEMENTATION_PLAN.md`
- `docs/design/POVOD_CARD_TEMPLATE_SYSTEM.md`

## Approved Logo

Source of truth:

- `docs/design/assets/logo-reference/gift_arch_symbol_exact_v2.svg`

Project copy for UI use:

- `public/brand/povod-logo.svg`

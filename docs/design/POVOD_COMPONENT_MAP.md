# Povod Component Map

## Назначение

Этот файл нужен, чтобы будущие дизайн-правки по «Поводу» оставались управляемыми: где бренд, где продуктовые компоненты, где preview, а где реальные production-поверхности.

Обновляй карту, когда появляются новые важные UI-компоненты или меняется структура интерфейса.

## Brand components

- BrandLogo
- BrandSymbol
- BrandMark
- BrandPalette
- BrandTypographyPreview
- BrandPreviewPage

Если таких компонентов ещё нет, создавать их только по отдельной задаче.

## Product components

- Header
- Navigation
- UserMenu
- MainLayout
- EmptyState
- StatusChip
- SoftButton
- IconButton
- InfoCard
- SectionHeader

## Domain components

Заполнять под реальные сценарии «Повода» после уточнения продукта.

- MainEntityCard
- EntityList
- EntityDetails
- CreateEntityForm
- EditEntityForm
- FiltersPanel
- SearchInput
- ActivityFeed
- NotificationChip

## Preview components

Использовать для безопасных дизайн-экспериментов:

- BrandPreviewPage
- UIPlayground
- ComponentShowcase
- VisualSystemPreview

Preview-компоненты не должны менять реальные пользовательские сценарии.

## Recommended hierarchy

1. Реальный пользовательский сценарий.
2. Основная информация и действие.
3. Статусы и вторичные данные.
4. Брендовые акценты.
5. Декор только если он поддерживает интерфейс.

## Maintenance notes

- Не переносить сюда компоненты из чужих проектов без адаптации.
- Не использовать `Sobralis`, `SOBRALIS` или другие чужие префиксы.
- Если компонент становится production-частью, добавить его фактический путь.
- Если компонент только экспериментальный, явно пометить его как preview.


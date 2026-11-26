/** The application chrome's icon set, drawn from the platform's product artwork. */
import type { ReactElement, SVGProps } from 'react'
import { ICON_ARTWORK } from './icon-artwork.ts'
import type { IconGlyph, IconShape } from './icon-artwork.ts'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  readonly size?: number
}

/** Render one copied SVG child with the platform attributes it carries. */
function shapeElement(entry: IconShape, index: number): ReactElement {
  switch (entry.tag) {
    case 'path': return <path key={index} {...entry.props as Omit<SVGProps<SVGPathElement>, 'ref'>} />
    case 'circle': return <circle key={index} {...entry.props as Omit<SVGProps<SVGCircleElement>, 'ref'>} />
    case 'rect': return <rect key={index} {...entry.props as Omit<SVGProps<SVGRectElement>, 'ref'>} />
  }
}

/** Build one icon component from its copied artwork. */
function icon(glyph: IconGlyph) {
  return function Icon({ size, ...rest }: IconProps) {
    const art = ICON_ARTWORK[glyph]
    return (
      <svg {...rest} width={size ?? art.size} height={size ?? art.size} viewBox={art.viewBox} {...art.root as SVGProps<SVGSVGElement>} aria-hidden="true">
        {art.shapes.map(shapeElement)}
      </svg>
    )
  }
}

export const IconAppsAddOutlineRegular = icon('apps-add-outline')
export const IconBranchOutlineRegular = icon('branch-outline')
export const IconChecklistOutlineRegular = icon('checklist-outline')
export const IconCheckOutlineRegular = icon('check-outline')
export const IconChevronDownOutlineRegular = icon('chevron-down-outline')
export const IconChevronLeftOutlineRegular = icon('chevron-left-outline')
export const IconChevronRightOutlineRegular = icon('chevron-right-outline')
export const IconCodeOutlineRegular = icon('code-outline')
export const IconCordisPluginOutlineRegular = icon('cordis-plugin-outline')
export const IconEllipsisOutlineRegular = icon('ellipsis-outline')
export const IconGaugeOutlineRegular = icon('gauge-outline')
export const IconGlobeOutlineRegular = icon('globe-outline')
export const IconListPenOutlineRegular = icon('list-pen-outline')
export const IconNewChatOutlineRegular = icon('new-chat-outline')
export const IconPanelLeftOutlineRegular = icon('panel-left-outline')
export const IconPlusOutlineRegular = icon('plus-outline')
export const IconRightUpOutlineRegular = icon('right-up-outline')
export const IconQueueOutlineRegular = icon('queue-outline')
export const IconSettingsOutlineRegular = icon('settings-outline')
export const IconWarningOutlineRegular = icon('warning-outline')
export const IconPinOutlineRegular = icon('pin-outline')
export const IconPinFillRegular = icon('pin-fill')

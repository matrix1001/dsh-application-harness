/**
 * Verbatim product icon artwork copied from
 * `@deepseek-ai/dsh-client-ui-primitives` (DeepSeek Harness, MIT).
 *
 * Each glyph keeps the platform's viewBox, root presentation attributes and
 * path/circle/rect children, so the local renderer draws the same geometry
 * instead of a hand-simplified approximation. Do not edit by hand: refresh by
 * re-reading `src/icons/artwork.ts` from the installed package at the current
 * platform line.
 */

/** The glyphs this package renders. */
export type IconGlyph =
  | 'apps-add-outline'
  | 'branch-outline'
  | 'checklist-outline'
  | 'check-outline'
  | 'chevron-down-outline'
  | 'chevron-left-outline'
  | 'chevron-right-outline'
  | 'code-outline'
  | 'cordis-plugin-outline'
  | 'ellipsis-outline'
  | 'gauge-outline'
  | 'globe-outline'
  | 'list-pen-outline'
  | 'new-chat-outline'
  | 'panel-left-outline'
  | 'plus-outline'
  | 'right-up-outline'
  | 'queue-outline'
  | 'settings-outline'
  | 'warning-outline'
  | 'pin-outline'
  | 'pin-fill'

/** One SVG child of a glyph. */
export interface IconShape {
  readonly tag: 'path' | 'circle' | 'rect'
  readonly props: Readonly<Record<string, string>>
}

/** One glyph: default height, user-space box, root attributes and children. */
export interface IconArtwork {
  readonly size: number
  readonly viewBox: string
  readonly root: Readonly<Record<string, string>>
  readonly shapes: readonly IconShape[]
}

/** The copied artwork, keyed by glyph name. */
export const ICON_ARTWORK: Readonly<Record<IconGlyph, IconArtwork>> = {
  'apps-add-outline': {
    size: 16,
    viewBox: '0 0 16 16',
    root: { fill: 'none', stroke: 'currentColor', strokeWidth: '1' },
    shapes: [
      { tag: 'rect', props: { x: '2.25', y: '2.25', width: '4', height: '4', rx: '1' } },
      { tag: 'rect', props: { x: '2.25', y: '9.75', width: '4', height: '4', rx: '1' } },
      { tag: 'rect', props: { x: '9.75', y: '9.75', width: '4', height: '4', rx: '1' } },
      { tag: 'path', props: { d: 'M11.75 1.75v5M9.25 4.25h5' } },
    ],
  },
  'branch-outline': {
    size: 16,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M1.01503 8.0001L5.6964 8.0001C6.41913 8.0001 6.78049 8.0001 7.12115 7.91951C7.4232 7.84804 7.71233 7.73014 7.97821 7.57C8.27809 7.38939 8.5364 7.13669 9.05303 6.63129L11.3281 4.40564', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M1.01221 7.9999L5.6964 7.9999C6.41913 7.9999 6.78049 7.9999 7.12115 8.08049C7.4232 8.15196 7.71233 8.26986 7.97821 8.43C8.27809 8.61061 8.5364 8.86331 9.05303 9.36871L11.3281 11.5944', stroke: 'currentColor' } },
      { tag: 'circle', props: { vectorEffect: 'non-scaling-stroke', cx: '12.4502', cy: '3.3079', r: '1.56962', stroke: 'currentColor' } },
      { tag: 'circle', props: { vectorEffect: 'non-scaling-stroke', cx: '12.4502', cy: '12.6921', r: '1.56962', stroke: 'currentColor' } },
    ],
  },
  'checklist-outline': {
    size: 14,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M3.75 6.25C4.7165 6.25 5.5 5.4665 5.5 4.5C5.5 3.5335 4.7165 2.75 3.75 2.75C2.7835 2.75 2 3.5335 2 4.5C2 5.4665 2.7835 6.25 3.75 6.25Z', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M7.5 4.5H13.5', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M3.75 13.25C4.7165 13.25 5.5 12.4665 5.5 11.5C5.5 10.5335 4.7165 9.75 3.75 9.75C2.7835 9.75 2 10.5335 2 11.5C2 12.4665 2.7835 13.25 3.75 13.25Z', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M7.5 11.5H13.5', stroke: 'currentColor' } },
    ],
  },
  'check-outline': {
    size: 16,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4', stroke: 'currentColor' } },
    ],
  },
  'chevron-down-outline': {
    size: 14,
    viewBox: '1 1 14 14',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6', stroke: 'currentColor' } },
    ],
  },
  'chevron-left-outline': {
    size: 14,
    viewBox: '1 1 14 14',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12', stroke: 'currentColor' } },
    ],
  },
  'chevron-right-outline': {
    size: 14,
    viewBox: '1 1 14 14',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4', stroke: 'currentColor' } },
    ],
  },
  'code-outline': {
    size: 16,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M6.27612 1.5L4.52612 14.5', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M11.4739 1.5L9.72388 14.5', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M2.39868 5.5H14.0681', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M1.93188 10.5H13.6013', stroke: 'currentColor' } },
    ],
  },
  'cordis-plugin-outline': {
    size: 14,
    viewBox: '-.5 -.5 17 17',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { d: 'M3.16143 6.59068L1.75205 8.00006L3.10619 9.35419L2.39908 10.0613L0.832948 8.49517C0.559581 8.2218 0.559582 7.77831 0.832948 7.50494L2.45432 5.88357L3.16143 6.59068ZM8.49511 15.1671C8.22176 15.4405 7.77826 15.4404 7.50489 15.1671L5.93461 13.5968L6.64172 12.8897L8 14.248L9.40938 12.8386L10.1165 13.5457L8.49511 15.1671ZM15.1671 7.50494C15.4403 7.7782 15.4401 8.22179 15.1671 8.49517L13.652 10.0102L12.9449 9.30309L14.248 8.00006L12.8897 6.64178L13.5968 5.93467L15.1671 7.50494ZM9.35414 3.10624L8 1.7521L6.69696 3.05514L5.98986 2.34803L7.50489 0.833003C7.77828 0.559981 8.22186 0.559752 8.49511 0.833003L10.0612 2.39913L9.35414 3.10624Z', fill: 'currentColor' } },
      { tag: 'circle', props: { vectorEffect: 'non-scaling-stroke', cx: '8', cy: '8', r: '1.76221', stroke: 'currentColor' } },
    ],
  },
  'ellipsis-outline': {
    size: 16,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { d: 'M3 9C3.55228 9 4 8.55228 4 8C4 7.44772 3.55228 7 3 7C2.44772 7 2 7.44772 2 8C2 8.55228 2.44772 9 3 9Z', fill: 'currentColor' } },
      { tag: 'path', props: { d: 'M8 9C8.55228 9 9 8.55228 9 8C9 7.44772 8.55228 7 8 7C7.44772 7 7 7.44772 7 8C7 8.55228 7.44772 9 8 9Z', fill: 'currentColor' } },
      { tag: 'path', props: { d: 'M13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z', fill: 'currentColor' } },
    ],
  },
  'gauge-outline': {
    size: 16,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M3.4041 13.096C2.49514 12.187 1.87614 11.0288 1.62537 9.76798C1.37459 8.50716 1.50331 7.20028 1.99525 6.01261C2.48719 4.82494 3.32025 3.80981 4.3891 3.09557C5.45795 2.38134 6.71458 2.00008 8.0001 2C9.28563 2.00008 10.5423 2.38134 11.6111 3.09557C12.68 3.80981 13.513 4.82494 14.005 6.01261C14.4969 7.20028 14.6256 8.50716 14.3748 9.76798C14.1241 11.0288 13.5051 12.187 12.5961 13.096', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M8 8.49994L11.6114 4.88855', stroke: 'currentColor' } },
      { tag: 'path', props: { d: 'M8 9.75C8.69036 9.75 9.25 9.19036 9.25 8.5C9.25 7.80964 8.69036 7.25 8 7.25C7.30964 7.25 6.75 7.80964 6.75 8.5C6.75 9.19036 7.30964 9.75 8 9.75Z', fill: 'currentColor' } },
    ],
  },
  'globe-outline': {
    size: 14,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M7.99986 14.0887C11.3626 14.0887 14.0886 11.3627 14.0886 7.99998C14.0886 4.63727 11.3626 1.91125 7.99986 1.91125C4.63715 1.91125 1.91113 4.63727 1.91113 7.99998C1.91113 11.3627 4.63715 14.0887 7.99986 14.0887Z', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M2.34619 8H13.6538', stroke: 'currentColor', strokeLinecap: 'square' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M7.99976 14.0889C9.23509 14.0889 10.1743 11.3629 10.1743 8.00006C10.1743 4.63739 9.23509 1.91138 7.99976 1.91138', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M7.99973 14.0889C6.76445 14.0889 5.8252 11.3629 5.8252 8.00006C5.8252 4.63739 6.76445 1.91138 7.99973 1.91138', stroke: 'currentColor' } },
    ],
  },
  'list-pen-outline': {
    size: 16,
    viewBox: '.5 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M4.9375 5.90295H11.0625', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M4.9375 9.02991H8.27841', stroke: 'currentColor' } },
      { tag: 'path', props: { d: 'M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V7.61328L13 8.68164V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H8.32812L7.39258 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5Z', fill: 'currentColor' } },
      { tag: 'path', props: { d: 'M8.97212 14.3693C9.17511 14.5723 9.37811 14.7753 9.5811 14.9783C9.67012 14.8953 9.75914 14.8123 9.84815 14.7293C11.4505 13.2352 13.0528 11.7411 14.6551 10.247C14.7441 10.164 14.8331 10.081 14.9221 9.99803C14.5989 9.6748 14.2756 9.35157 13.9524 9.02834C13.8694 9.11736 13.7864 9.20637 13.7034 9.29539C12.2093 10.8977 10.7152 12.5 9.22113 14.1023C9.13813 14.1913 9.05513 14.2803 8.97212 14.3693Z', fill: 'currentColor' } },
      { tag: 'path', props: { d: 'M11.6323 13.7841C11.6323 14.0395 11.6323 14.295 11.6323 14.5504C11.6812 14.5523 11.7301 14.5543 11.779 14.5562C12.659 14.5913 13.539 14.6263 14.419 14.6614C14.4679 14.6633 14.5168 14.6653 14.5657 14.6672C14.5657 14.3339 14.5657 14.0006 14.5657 13.6672C14.5168 13.6692 14.4679 13.6711 14.419 13.6731C13.539 13.7081 12.659 13.7432 11.779 13.7783C11.7301 13.7802 11.6812 13.7821 11.6323 13.7841Z', fill: 'currentColor' } },
    ],
  },
  'new-chat-outline': {
    size: 16,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M8 5V11', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M5 8H11', stroke: 'currentColor' } },
    ],
  },
  'panel-left-outline': {
    size: 16,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M5.5 1.5V14.5', stroke: 'currentColor' } },
    ],
  },
  'plus-outline': {
    size: 16,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M8 2V14', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M2 8H14', stroke: 'currentColor' } },
    ],
  },
  'right-up-outline': {
    size: 16,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { d: 'M11.7256 2.77441C12.5538 2.77469 13.2256 3.44616 13.2256 4.27441V10.1416H12.2256V4.27441C12.2256 3.99844 12.0015 3.77469 11.7256 3.77441H5.7207V2.77441H11.7256Z', fill: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M2.77441 13.2255L12.3756 3.62427', stroke: 'currentColor' } },
    ],
  },
  'queue-outline': {
    size: 14,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M5 6.75H11', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M5 9H8', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M2.37067 11.2497C1.5872 9.89252 1.32042 8.29798 1.61945 6.7597C1.91847 5.22141 2.76317 3.84293 3.99801 2.87809C5.23285 1.91325 6.7747 1.427 8.33964 1.50888C9.90458 1.59076 11.3873 2.23526 12.5147 3.32369C13.6422 4.41232 14.3384 5.8717 14.4751 7.43304C14.6118 8.99438 14.1797 10.5525 13.2585 11.8205C12.3372 13.0885 10.9889 13.9809 9.4617 14.3334C8.18666 14.6277 6.8587 14.529 5.64964 14.0601C5.17095 13.8745 4.76937 13.4929 4.26509 13.3963C3.67389 13.2832 2.95232 13.5595 2.0377 14.3334', stroke: 'currentColor' } },
    ],
  },
  'settings-outline': {
    size: 16,
    viewBox: '.5 .5 15 15',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z', stroke: 'currentColor', strokeMiterlimit: '10' } },
    ],
  },
  'warning-outline': {
    size: 16,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M8 4.29199V9.79199', stroke: 'currentColor' } },
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M8 10.708V11.708', stroke: 'currentColor' } },
    ],
  },
  'pin-outline': {
    size: 16,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z', stroke: 'currentColor', strokeLinejoin: 'round' } },
      { tag: 'path', props: { d: 'M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z', fill: 'currentColor' } },
    ],
  },
  'pin-fill': {
    size: 16,
    viewBox: '0 0 16 16',
    root: { fill: 'none', strokeWidth: '1' },
    shapes: [
      { tag: 'path', props: { vectorEffect: 'non-scaling-stroke', d: 'M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z', fill: 'currentColor', stroke: 'currentColor', strokeLinejoin: 'round' } },
      { tag: 'path', props: { d: 'M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z', fill: 'currentColor' } },
    ],
  },
}

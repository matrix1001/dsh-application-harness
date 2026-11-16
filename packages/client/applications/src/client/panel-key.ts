/**
 * The one key the applications surface is addressed by: the keyed `main`
 * slot's key, and the sidebar rail entry's list id (the platform's rail
 * button selects the main key of its own id, so the two must be the same
 * value). Its own module so the panel's own tests name it directly instead of
 * widening the package's public API.
 * @module @matrix1001/dsh-application-harness-client-applications/client/panel-key
 */
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

/** The keyed `main` panel this package occupies. */
export const APPLICATION_PANEL_KEY = 'applications' as MainPanelId

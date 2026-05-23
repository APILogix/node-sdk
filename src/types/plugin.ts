import type { SDKEvent } from './event.js'
import type { Breadcrumb, BreadcrumbHint, BreadcrumbInput } from './breadcrumb.js'
import type { ResolvedSDKConfig } from './config.js'

/**
 * An EventProcessor transforms or filters events in the processing pipeline.
 * Return the event to pass it through, or return null to drop it.
 */
export type EventProcessor = (event: SDKEvent) => SDKEvent | null | Promise<SDKEvent | null>

/**
 * A BreadcrumbProcessor transforms or filters breadcrumbs.
 * Return the breadcrumb to keep it, or return null to drop it.
 */
export type BreadcrumbProcessor = (
  breadcrumb: Breadcrumb,
  hint?: BreadcrumbHint
) => Breadcrumb | null

/**
 * Plugin metadata for identification and debugging.
 */
export interface PluginMeta {
  /** Unique plugin name — must be unique across all registered plugins. */
  readonly name: string
  /** Semver version string of the plugin. */
  readonly version: string
}

/**
 * Read-only context provided to plugins during lifecycle hooks.
 * Plugins should NOT mutate SDK state directly.
 */
export interface PluginContext {
  /** Resolved SDK configuration (read-only). */
  readonly config: Readonly<ResolvedSDKConfig>
  /** SDK metadata — service name, environment, release. */
  readonly metadata: Readonly<{
    service: string
    environment: string
    release: string
    sdkVersion: string
  }>
}

/**
 * SDK Plugin interface — the extension point for third-party integrations.
 *
 * Plugins participate in the event lifecycle via hooks.
 * All hooks are optional. A plugin must provide at least `meta`.
 *
 * Execution order: plugins execute in registration order.
 * Error isolation: a failing plugin does not block other plugins.
 */
export interface SDKPlugin {
  /** Plugin identification metadata. */
  readonly meta: PluginMeta

  /**
   * Called once during SDK initialization, after config is resolved.
   * Use this to set up internal state, register event processors, etc.
   */
  setup?(context: PluginContext): void | Promise<void>

  /**
   * Event processor — called for every event before it enters the queue.
   * Return the event to pass it through, or null to drop it.
   */
  processEvent?(event: SDKEvent): SDKEvent | null | Promise<SDKEvent | null>

  /**
   * Called before a breadcrumb is added to the buffer.
   * Return the breadcrumb to keep it, or null to drop it.
   */
  processBreadcrumb?(breadcrumb: Breadcrumb, hint?: BreadcrumbHint): Breadcrumb | null

  /**
   * Called just before a batch is sent to the ingestion API.
   * Can be used for last-minute enrichment or filtering.
   */
  beforeSend?(event: SDKEvent): SDKEvent | null | Promise<SDKEvent | null>

  /**
   * Called after a batch is successfully sent.
   * Useful for metrics/accounting plugins.
   */
  afterSend?(events: readonly SDKEvent[]): void

  /**
   * Called before a flush operation begins.
   */
  beforeFlush?(): void

  /**
   * Called when a transport error occurs (after retry exhaustion).
   */
  onTransportError?(error: Error, events: readonly SDKEvent[]): void

  /**
   * Called during SDK shutdown. Clean up resources here.
   * Must complete within the shutdown timeout.
   */
  teardown?(): void | Promise<void>
}

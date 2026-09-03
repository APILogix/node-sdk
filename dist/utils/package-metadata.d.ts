import type { SDKInitOptions } from '../types/config.js';
export interface ApplicationPackageMetadata {
    readonly name: string;
    readonly version: string;
    readonly packageJsonPath?: string;
}
/** Resolve consuming-app identity once during SDK initialization. Never throws. */
export declare function resolveApplicationPackage(options: SDKInitOptions): ApplicationPackageMetadata;

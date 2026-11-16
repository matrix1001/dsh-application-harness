/**
 * The author-facing typed operation helper. The application author writes one
 * platform-DSL declaration; `defineOperation` derives the `execute` argument
 * and result types from that same declaration, so the runtime validator, the
 * exported JSON Schema and the TypeScript signature cannot drift.
 *
 * The returned value is the runtime's type-erased `OperationDeclaration`: the
 * registry stores heterogeneous operations, while the author keeps full
 * inference at the declaration site.
 * @module @matrix1001/dsh-application-harness-runtime/define
 */

import type { InferArgs, InferValue, ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { OperationContext, OperationDeclaration, OperationEffect, OpExposure } from './types.ts'

/**
 * One operation written with the platform schema DSL. The schemas are the
 * source; the execute signature is derived from them.
 */
export interface DefinedOperation<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  /** Human- and model-readable purpose. */
  readonly description: string
  /** Platform-DSL parameter schema. */
  readonly params: S
  /** Platform-DSL result schema. */
  readonly result: O
  /** Author default per caller class; omitted classes are closed. */
  readonly exposure?: OpExposure
  /** Read or write; omitted means write. */
  readonly effect?: OperationEffect
  /** Business implementation; arguments/results are inferred from the schemas. */
  readonly execute: (args: InferArgs<S>, ctx: OperationContext) => InferValue<O> | Promise<InferValue<O>>
}

/**
 * Declare one typed application operation.
 * @param operation - the declaration and its implementation.
 * @returns the runtime's type-erased operation declaration.
 */
export function defineOperation<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  operation: DefinedOperation<S, O>,
): OperationDeclaration {
  return operation as unknown as OperationDeclaration
}

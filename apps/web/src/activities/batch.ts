import { type Bounds, unionBounds } from "@collab/geometry";
import { MAX_BATCH_OPERATIONS, validateDurableOperation } from "@collab/protocol";

import type { BatchItemOperation, DurableOperation, NewBoardItem, Point } from "../types";
import { roundBoard } from "../types";

export type ItemsBatchOperation = Extract<DurableOperation, { kind: "items.batch" }>;

/** Records the item id and wraps it in an AI-attributed create operation. */
export function createItem(item: NewBoardItem, itemIds: string[]): BatchItemOperation {
  itemIds.push(item.id);
  return { kind: "item.create", item: { ...item, assistedBy: "ai" } as NewBoardItem };
}

export function finalizeBatch(
  operations: BatchItemOperation[],
  sizeMessage: string,
  {
    errorType = Error,
    rejectEmpty = false,
  }: { errorType?: new (message: string) => Error; rejectEmpty?: boolean } = {},
): ItemsBatchOperation {
  if ((rejectEmpty && operations.length === 0) || operations.length > MAX_BATCH_OPERATIONS) {
    throw new errorType(sizeMessage);
  }
  return validateDurableOperation({ kind: "items.batch", operations }) as ItemsBatchOperation;
}

/** Union of every source's bounds, or null when there are no sources. */
export function combinedBounds(sources: readonly { bounds: Bounds }[]): Bounds | null {
  return sources.reduce<Bounds | null>(
    (combined, source) => (combined ? unionBounds(combined, source.bounds) : source.bounds),
    null,
  );
}

export function boundsCenter(bounds: Bounds): Point {
  return [roundBoard((bounds.minX + bounds.maxX) / 2), roundBoard((bounds.minY + bounds.maxY) / 2)];
}

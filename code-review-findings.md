# Code Review Findings - Consolidated & Prioritized

## 🔴 Critical: Correctness Bugs

### 1. **Resource Leak in subprocess.ts**

**File:** `src/engine/subprocess.ts:350-358`  
**Severity:** HIGH - Resource accumulation over time

**Issue:** If `abort()` is called after process completion, an uncleaned `forceKillTimer` is created and never cleared.

**Root Cause:**

- The `abort()` method checks `wasAborted` and `proc` existence, but not `settled`
- After normal completion, `settled = true` but `proc` still exists
- Calling `abort()` creates a 5-second timer that never gets cleared

**Impact:** Accumulates timers in high-frequency spawn scenarios

**Fix:**

```typescript
abort: () => {
  if (wasAborted || settled) return;  // Add settled check
  wasAborted = true;
  if (!proc) return;
  proc.kill("SIGTERM");
  forceKillTimer = setTimeout(() => {
    if (proc && isChildProcessRunning(proc)) proc.kill("SIGKILL");
  }, FORCE_KILL_AFTER_MS);
},
```

---

## 🟠 High Priority: Code Duplication

### 2. **Duplicate Error Message Formatting**

**Files:** `src/catalog/agents.ts`, `src/catalog/workflows.ts`  
**Lines saved:** ~10

Identical `toErrorMessage()` functions in multiple files.

**Action:** Extract to `src/utils/errors.ts`

```typescript
export function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
```

---

### 3. **Duplicate Directory Discovery Logic**

**Files:** `src/catalog/agents.ts:193-207`, `src/catalog/workflows.ts:75-86`  
**Lines saved:** ~40

Three nearly identical functions:

- `findNearestProjectAgentsDir()`
- `findNearestProjectWorkflowsDir()`
- `findNearestProjectSkillsCwd()`

**Action:** Create generic utility

```typescript
function findNearestProjectDir(
  cwd: string,
  subdirName: string,
  userDir: string,
): string | undefined;
```

---

### 4. **Duplicate `isDirectory()` Helper**

**Files:** `src/catalog/agents.ts:83-89`, `src/catalog/workflows.ts:67-73`  
**Lines saved:** ~14

Exact duplication of filesystem check utility.

**Action:** Move to `src/utils/fs.ts`

---

### 5. **Redundant XML Escaping Functions**

**File:** `src/catalog/agents.ts:405-418`  
**Risk:** HIGH - Security-sensitive code

Rolling custom XML escaping is error-prone.

**Action:** Use a well-tested XML library (e.g., `fast-xml-parser`, `xmlbuilder2`) or validate current implementation against OWASP test vectors.

---

## 🟡 Medium Priority: Complexity & Maintainability

### 6. **Complex Validation Module**

**File:** `src/model/validate.ts` (800+ lines)  
**Cyclomatic complexity:** HIGH

Issues:

- `parseFlowNode()`: Large switch statement (lines 194-223)
- `checkNode()`: Deep nesting and complex scope rules (lines 713-796)
- `expandNode()`: Mixes recursion with mutation (lines 649-711)

**Action:**

1. Split into separate files: `parse.ts`, `expand.ts`, `scope-check.ts`
2. Extract each node-kind parser into dedicated functions
3. Consider visitor pattern for tree traversal

---

### 7. **Long Interpreter Class**

**File:** `src/run/interpreter.ts` (560+ lines)  
**Single Responsibility violation**

Mixed concerns:

- Event emission
- Budget tracking
- Error handling
- Value resolution
- Concurrent execution

**Action:** Extract responsibilities:

- `EventEmitter` for run events
- `BudgetTracker` encapsulation
- Separate `ParExecutor`, `MapExecutor`, `LoopExecutor` classes

---

### 8. **Complex Error Construction**

**Files:** `src/run/scheduler.ts:110-118`, `src/run/interpreter.ts:177-188`

Repeated complex logic to extract cancellation reasons from nested errors and signals.

**Action:** Create centralized utility

```typescript
class ErrorContext {
  static getCancelReason(
    error: unknown,
    signal: AbortSignal,
  ): CancelReason | undefined;
  static formatError(error: unknown): string;
}
```

---

### 9. **Magic String Comparisons**

**Files:** Multiple (`agents.ts:97-105`, `workflows.ts:43-52`, `events.ts`)  
**Maintainability risk:** MEDIUM

Scattered string literals for validation and event types.

**Action:**

- Use enums or const objects for all magic strings
- Create type guards for runtime validation
- Example: `enum EventType`, `enum FrontmatterKey`

---

### 10. **Scope Resolution Switch Statement**

**File:** `src/run/interpreter.ts:87-118`

Large conditional structure for environment variable resolution.

**Action:** Use lookup map for O(1) resolution

```typescript
const specialRoots = new Map([
  [
    "previous",
    (env: Env) =>
      env.hasPrevious ? { found: true, value: env.previous } : { found: false },
  ],
  [
    "item",
    (env: Env) =>
      env.inMap ? { found: true, value: env.item } : { found: false },
  ],
  // ...
]);
```

---

## 🟢 Low Priority: Polish

### 11. **Inconsistent Function Placement**

**Files:** Multiple

Helper functions placed inconsistently (top, bottom, inline).

**Action:** Establish convention:

1. Exports (types, interfaces)
2. Constants
3. Public functions
4. Private helper functions

---

### 12. **Lack of Type Narrowing**

**File:** `src/run/scheduler.ts:97-108`

Multiple type assertions for array access without proper narrowing.

**Action:** Add null checks

```typescript
const task = tasks[index];
if (!task) continue; // or throw
```

---

### 13. **XML String Building Readability**

**File:** `src/catalog/agents.ts:421-483`

Array operations for XML building could be more readable.

**Action:** Consider template literals or lightweight XML builder class for clarity.

---

### 14. **Workflow Parameter Resolution Nesting**

**File:** `src/catalog/workflows.ts:88-166`

Nested conditionals in `parseParams()` could be flattened.

**Action:** Extract validation into `validateParam()` helper function.

---

## 📊 Summary Statistics

| Metric                         | Count                                            |
| ------------------------------ | ------------------------------------------------ |
| **Correctness bugs**           | 1 critical                                       |
| **Duplicate code instances**   | 4 major (~100 lines)                             |
| **Files > 500 lines**          | 3 (`validate.ts`, `interpreter.ts`, `agents.ts`) |
| **Functions > 100 lines**      | ~5                                               |
| **High cyclomatic complexity** | 3 functions                                      |

---

## 🎯 Recommended Action Plan (Priority Order)

1. ✅ **Fix resource leak in subprocess.ts** (30 min) - Critical bug
2. ✅ **Deduplicate utility functions** (1-2 hours) - Extract to `src/utils/`
3. ✅ **Centralize error handling** (2-3 hours) - Create `ErrorContext` utility
4. ✅ **Split validate.ts** (4-6 hours) - Create focused modules
5. ✅ **Refactor Interpreter class** (4-6 hours) - Extract executors
6. ✅ **Add type guards & enums** (2-3 hours) - Replace magic strings
7. ⏸️ **Polish & cleanup** (ongoing) - Address low-priority items incrementally

---

## ℹ️ Non-Issues (Verified Correct)

These were reviewed and confirmed working as designed:

- ✓ **Budget counter behavior** - Counts spawn attempts (not successful runs), intentional
- ✓ **Semaphore implementation** - Properly handles slot handoff and idempotent release
- ✓ **Scheduler pool logic** - Correctly handles fail-fast, quorum, and cancellation
- ✓ **Boolean predicate evaluation** - Already clean, discriminated unions used well

---

## 🔍 Review Context

- **Total files reviewed:** ~15 core modules
- **Focus areas:** Correctness, duplication, complexity, maintainability
- **Code quality:** Generally well-structured with strong separation of concerns
- **Main issues:** Manageable duplication and overly long functions

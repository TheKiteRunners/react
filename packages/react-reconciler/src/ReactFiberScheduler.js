/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {Batch, FiberRoot} from './ReactFiberRoot';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {Interaction} from 'scheduler/src/Tracing';

import {
  __interactionsRef,
  __subscriberRef,
  unstable_wrap as Scheduler_tracing_wrap,
} from 'scheduler/tracing';
import {
  unstable_next as Scheduler_next,
  unstable_getCurrentPriorityLevel as getCurrentPriorityLevel,
  unstable_runWithPriority as runWithPriority,
  unstable_ImmediatePriority as ImmediatePriority,
  unstable_UserBlockingPriority as UserBlockingPriority,
  unstable_NormalPriority as NormalPriority,
  unstable_LowPriority as LowPriority,
  unstable_IdlePriority as IdlePriority,
} from 'scheduler';
import {
  invokeGuardedCallback,
  hasCaughtError,
  clearCaughtError,
} from 'shared/ReactErrorUtils';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import ReactStrictModeWarnings from './ReactStrictModeWarnings';
import {
  NoEffect,
  PerformedWork,
  Placement,
  Update,
  Snapshot,
  PlacementAndUpdate,
  Deletion,
  ContentReset,
  Callback,
  DidCapture,
  Ref,
  Incomplete,
  HostEffectMask,
  Passive,
} from 'shared/ReactSideEffectTags';
import {
  ClassComponent,
  HostComponent,
  ContextProvider,
  ForwardRef,
  FunctionComponent,
  HostPortal,
  HostRoot,
  MemoComponent,
  SimpleMemoComponent,
  SuspenseComponent,
  DehydratedSuspenseComponent,
} from 'shared/ReactWorkTags';
import {
  enableSchedulerTracing,
  enableProfilerTimer,
  enableUserTimingAPI,
  replayFailedUnitOfWorkWithInvokeGuardedCallback,
  warnAboutDeprecatedLifecycles,
  enableSuspenseServerRenderer,
} from 'shared/ReactFeatureFlags';
import getComponentName from 'shared/getComponentName';
import invariant from 'shared/invariant';
import warningWithoutStack from 'shared/warningWithoutStack';

import ReactFiberInstrumentation from './ReactFiberInstrumentation';
import {
  getStackByFiberInDevAndProd,
  phase as ReactCurrentFiberPhase,
  resetCurrentFiber,
  setCurrentFiber,
} from './ReactCurrentFiber';
import {
  now,
  scheduleDeferredCallback,
  cancelDeferredCallback,
  shouldYield,
  prepareForCommit,
  resetAfterCommit,
  scheduleTimeout,
  cancelTimeout,
  noTimeout,
  schedulePassiveEffects,
  cancelPassiveEffects,
} from './ReactFiberHostConfig';
import {
  markPendingPriorityLevel,
  markCommittedPriorityLevels,
  markSuspendedPriorityLevel,
  markPingedPriorityLevel,
  hasLowerPriorityWork,
  isPriorityLevelSuspended,
  findEarliestOutstandingPriorityLevel,
  didExpireAtExpirationTime,
} from './ReactFiberPendingPriority';
import {
  recordEffect,
  recordScheduleUpdate,
  startRequestCallbackTimer,
  stopRequestCallbackTimer,
  startWorkTimer,
  stopWorkTimer,
  stopFailedWorkTimer,
  startWorkLoopTimer,
  stopWorkLoopTimer,
  startCommitTimer,
  stopCommitTimer,
  startCommitSnapshotEffectsTimer,
  stopCommitSnapshotEffectsTimer,
  startCommitHostEffectsTimer,
  stopCommitHostEffectsTimer,
  startCommitLifeCyclesTimer,
  stopCommitLifeCyclesTimer,
} from './ReactDebugFiberPerf';
import {createWorkInProgress, assignFiberPropertiesInDEV} from './ReactFiber';
import {onCommitRoot} from './ReactFiberDevToolsHook';
import {
  NoWork,
  Sync,
  Never,
  msToExpirationTime,
  expirationTimeToMs,
  computeAsyncExpiration,
  computeInteractiveExpiration,
} from './ReactFiberExpirationTime';
import {ConcurrentMode, ProfileMode, NoContext} from './ReactTypeOfMode';
import {enqueueUpdate, resetCurrentlyProcessingQueue} from './ReactUpdateQueue';
import {createCapturedValue} from './ReactCapturedValue';
import {
  isContextProvider as isLegacyContextProvider,
  popTopLevelContextObject as popTopLevelLegacyContextObject,
  popContext as popLegacyContext,
} from './ReactFiberContext';
import {popProvider, resetContextDependences} from './ReactFiberNewContext';
import {resetHooks} from './ReactFiberHooks';
import {popHostContext, popHostContainer} from './ReactFiberHostContext';
import {
  recordCommitTime,
  startProfilerTimer,
  stopProfilerTimerIfRunningAndRecordDelta,
} from './ReactProfilerTimer';
import {
  checkThatStackIsEmpty,
  resetStackAfterFatalErrorInDev,
} from './ReactFiberStack';
import {beginWork} from './ReactFiberBeginWork';
import {completeWork} from './ReactFiberCompleteWork';
import {
  throwException,
  unwindWork,
  unwindInterruptedWork,
  createRootErrorUpdate,
  createClassErrorUpdate,
} from './ReactFiberUnwindWork';
import {
  commitBeforeMutationLifeCycles,
  commitResetTextContent,
  commitPlacement,
  commitDeletion,
  commitWork,
  commitLifeCycles,
  commitAttachRef,
  commitDetachRef,
  commitPassiveHookEffects,
} from './ReactFiberCommitWork';
import {ContextOnlyDispatcher} from './ReactFiberHooks';

export type Thenable = {
  then(resolve: () => mixed, reject?: () => mixed): mixed,
};

const {ReactCurrentDispatcher, ReactCurrentOwner} = ReactSharedInternals;

let didWarnAboutStateTransition;
let didWarnSetStateChildContext;
let warnAboutUpdateOnUnmounted;
let warnAboutInvalidUpdates;

if (enableSchedulerTracing) {
  // Provide explicit error message when production+profiling bundle of e.g. react-dom
  // is used with production (non-profiling) bundle of scheduler/tracing
  invariant(
    __interactionsRef != null && __interactionsRef.current != null,
    'It is not supported to run the profiling version of a renderer (for example, `react-dom/profiling`) ' +
      'without also replacing the `scheduler/tracing` module with `scheduler/tracing-profiling`. ' +
      'Your bundler might have a setting for aliasing both modules. ' +
      'Learn more at http://fb.me/react-profiling',
  );
}

if (__DEV__) {
  didWarnAboutStateTransition = false;
  didWarnSetStateChildContext = false;
  const didWarnStateUpdateForUnmountedComponent = {};

  warnAboutUpdateOnUnmounted = function(fiber: Fiber, isClass: boolean) {
    // We show the whole stack but dedupe on the top component's name because
    // the problematic code almost always lies inside that component.
    const componentName = getComponentName(fiber.type) || 'ReactComponent';
    if (didWarnStateUpdateForUnmountedComponent[componentName]) {
      return;
    }
    warningWithoutStack(
      false,
      "Can't perform a React state update on an unmounted component. This " +
        'is a no-op, but it indicates a memory leak in your application. To ' +
        'fix, cancel all subscriptions and asynchronous tasks in %s.%s',
      isClass
        ? 'the componentWillUnmount method'
        : 'a useEffect cleanup function',
      getStackByFiberInDevAndProd(fiber),
    );
    didWarnStateUpdateForUnmountedComponent[componentName] = true;
  };

  warnAboutInvalidUpdates = function(instance: React$Component<any>) {
    switch (ReactCurrentFiberPhase) {
      case 'getChildContext':
        if (didWarnSetStateChildContext) {
          return;
        }
        warningWithoutStack(
          false,
          'setState(...): Cannot call setState() inside getChildContext()',
        );
        didWarnSetStateChildContext = true;
        break;
      case 'render':
        if (didWarnAboutStateTransition) {
          return;
        }
        warningWithoutStack(
          false,
          'Cannot update during an existing state transition (such as within ' +
            '`render`). Render methods should be a pure function of props and state.',
        );
        didWarnAboutStateTransition = true;
        break;
    }
  };
}

// Used to ensure computeUniqueAsyncExpiration is monotonically decreasing.
let lastUniqueAsyncExpiration: number = Sync - 1;

let isWorking: boolean = false;

// The next work in progress fiber that we're currently working on.
let nextUnitOfWork: Fiber | null = null;
let nextRoot: FiberRoot | null = null;
// The time at which we're currently rendering work.
let nextRenderExpirationTime: ExpirationTime = NoWork;
let nextLatestAbsoluteTimeoutMs: number = -1;
let nextRenderDidError: boolean = false;

// The next fiber with an effect that we're currently committing.
let nextEffect: Fiber | null = null;

let isCommitting: boolean = false;
let rootWithPendingPassiveEffects: FiberRoot | null = null;
let passiveEffectCallbackHandle: * = null;
let passiveEffectCallback: * = null;

let legacyErrorBoundariesThatAlreadyFailed: Set<mixed> | null = null;

// Used for performance tracking.
let interruptedBy: Fiber | null = null;

let stashedWorkInProgressProperties;
let replayUnitOfWork;
let mayReplayFailedUnitOfWork;
let isReplayingFailedUnitOfWork;
let originalReplayError;
let rethrowOriginalError;
if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
  stashedWorkInProgressProperties = null;
  mayReplayFailedUnitOfWork = true;
  isReplayingFailedUnitOfWork = false;
  originalReplayError = null;
  replayUnitOfWork = (
    failedUnitOfWork: Fiber,
    thrownValue: mixed,
    isYieldy: boolean,
  ) => {
    if (
      thrownValue !== null &&
      typeof thrownValue === 'object' &&
      typeof thrownValue.then === 'function'
    ) {
      // Don't replay promises. Treat everything else like an error.
      // TODO: Need to figure out a different strategy if/when we add
      // support for catching other types.
      return;
    }

    // Restore the original state of the work-in-progress
    if (stashedWorkInProgressProperties === null) {
      // This should never happen. Don't throw because this code is DEV-only.
      warningWithoutStack(
        false,
        'Could not replay rendering after an error. This is likely a bug in React. ' +
          'Please file an issue.',
      );
      return;
    }
    assignFiberPropertiesInDEV(
      failedUnitOfWork,
      stashedWorkInProgressProperties,
    );

    switch (failedUnitOfWork.tag) {
      case HostRoot:
        popHostContainer(failedUnitOfWork);
        popTopLevelLegacyContextObject(failedUnitOfWork);
        break;
      case HostComponent:
        popHostContext(failedUnitOfWork);
        break;
      case ClassComponent: {
        const Component = failedUnitOfWork.type;
        if (isLegacyContextProvider(Component)) {
          popLegacyContext(failedUnitOfWork);
        }
        break;
      }
      case HostPortal:
        popHostContainer(failedUnitOfWork);
        break;
      case ContextProvider:
        popProvider(failedUnitOfWork);
        break;
    }
    // Replay the begin phase.
    isReplayingFailedUnitOfWork = true;
    originalReplayError = thrownValue;
    invokeGuardedCallback(null, workLoop, null, isYieldy);
    isReplayingFailedUnitOfWork = false;
    originalReplayError = null;
    if (hasCaughtError()) {
      const replayError = clearCaughtError();
      if (replayError != null && thrownValue != null) {
        try {
          // Reading the expando property is intentionally
          // inside `try` because it might be a getter or Proxy.
          if (replayError._suppressLogging) {
            // Also suppress logging for the original error.
            (thrownValue: any)._suppressLogging = true;
          }
        } catch (inner) {
          // Ignore.
        }
      }
    } else {
      // If the begin phase did not fail the second time, set this pointer
      // back to the original value.
      nextUnitOfWork = failedUnitOfWork;
    }
  };
  rethrowOriginalError = () => {
    throw originalReplayError;
  };
}

function resetStack() {
  // nextUnitOfWork为变量初始值为null
  if (nextUnitOfWork !== null) {
    let interruptedWork = nextUnitOfWork.return;
    while (interruptedWork !== null) {
      unwindInterruptedWork(interruptedWork);
      interruptedWork = interruptedWork.return;
    }
  }

  if (__DEV__) {
    ReactStrictModeWarnings.discardPendingWarnings();
    checkThatStackIsEmpty();
  }

  nextRoot = null;
  nextRenderExpirationTime = NoWork;
  nextLatestAbsoluteTimeoutMs = -1;
  nextRenderDidError = false;
  nextUnitOfWork = null;
}

function commitAllHostEffects() {
  while (nextEffect !== null) {
    if (__DEV__) {
      setCurrentFiber(nextEffect);
    }
    recordEffect();

    const effectTag = nextEffect.effectTag;

    if (effectTag & ContentReset) {
      // 重置节点文字内容
      commitResetTextContent(nextEffect);
    }

    if (effectTag & Ref) {
      const current = nextEffect.alternate;
      if (current !== null) {
        commitDetachRef(current);
      }
    }

    // The following switch statement is only concerned about placement,
    // updates, and deletions. To avoid needing to add a case for every
    // possible bitmap value, we remove the secondary effects from the
    // effect tag and switch on that value.
    //以下switch语句仅关注placement, updates, and deletions 
    let primaryEffectTag = effectTag & (Placement | Update | Deletion);
    switch (primaryEffectTag) {
      case Placement: {
        commitPlacement(nextEffect);
        // Clear the "placement" from effect tag so that we know that this is inserted, before
        // any life-cycles like componentDidMount gets called.
        // TODO: findDOMNode doesn't rely on this any more but isMounted
        // does and isMounted is deprecated anyway so we should be able
        // to kill this.

        // nextEffect.effectTag目前为2
        // Placement常量值为0b000000000010
        // 具体位运算可以参考https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Operators/Bitwise_Operators
        nextEffect.effectTag &= ~Placement; // nextEffect.effectTag = 0
        break;
      }
      case PlacementAndUpdate: {
        // Placement
        commitPlacement(nextEffect);
        // Clear the "placement" from effect tag so that we know that this is inserted, before
        // any life-cycles like componentDidMount gets called.
        nextEffect.effectTag &= ~Placement;

        // Update
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Update: {
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Deletion: {
        commitDeletion(nextEffect);
        break;
      }
    }
    nextEffect = nextEffect.nextEffect;
  }

  if (__DEV__) {
    resetCurrentFiber();
  }
}

function commitBeforeMutationLifecycles() {
  // nextEffect为Text Fiber Node
  while (nextEffect !== null) {
    if (__DEV__) {
      setCurrentFiber(nextEffect);
    }

    const effectTag = nextEffect.effectTag; // 2
    // Snapshot是常量值为0b000100000000
    if (effectTag & Snapshot) { // 此时执行不到
      recordEffect();
      const current = nextEffect.alternate;
      commitBeforeMutationLifeCycles(current, nextEffect);
    }

    nextEffect = nextEffect.nextEffect; // 镜像Fiber Node, 之后再来一遍循环
  }

  if (__DEV__) {
    resetCurrentFiber();
  }
}

function commitAllLifeCycles(
  finishedRoot: FiberRoot,
  committedExpirationTime: ExpirationTime,
) {
  if (__DEV__) {
    ReactStrictModeWarnings.flushPendingUnsafeLifecycleWarnings();
    ReactStrictModeWarnings.flushLegacyContextWarning();

    if (warnAboutDeprecatedLifecycles) {
      ReactStrictModeWarnings.flushPendingDeprecationWarnings();
    }
  }
  while (nextEffect !== null) {
    if (__DEV__) {
      setCurrentFiber(nextEffect);
    }
    const effectTag = nextEffect.effectTag;

    if (effectTag & (Update | Callback)) {
      recordEffect();
      const current = nextEffect.alternate;
      commitLifeCycles(
        finishedRoot,
        current,
        nextEffect,
        committedExpirationTime,
      );
    }

    if (effectTag & Ref) {
      recordEffect();
      commitAttachRef(nextEffect);
    }

    if (effectTag & Passive) {
      rootWithPendingPassiveEffects = finishedRoot;
    }

    nextEffect = nextEffect.nextEffect;
  }
  if (__DEV__) {
    resetCurrentFiber();
  }
}

function commitPassiveEffects(root: FiberRoot, firstEffect: Fiber): void {
  rootWithPendingPassiveEffects = null;
  passiveEffectCallbackHandle = null;
  passiveEffectCallback = null;

  // Set this to true to prevent re-entrancy
  const previousIsRendering = isRendering;
  isRendering = true;

  let effect = firstEffect;
  do {
    if (__DEV__) {
      setCurrentFiber(effect);
    }

    if (effect.effectTag & Passive) {
      let didError = false;
      let error;
      if (__DEV__) {
        invokeGuardedCallback(null, commitPassiveHookEffects, null, effect);
        if (hasCaughtError()) {
          didError = true;
          error = clearCaughtError();
        }
      } else {
        try {
          commitPassiveHookEffects(effect);
        } catch (e) {
          didError = true;
          error = e;
        }
      }
      if (didError) {
        captureCommitPhaseError(effect, error);
      }
    }
    effect = effect.nextEffect;
  } while (effect !== null);
  if (__DEV__) {
    resetCurrentFiber();
  }

  isRendering = previousIsRendering;

  // Check if work was scheduled by one of the effects
  const rootExpirationTime = root.expirationTime;
  if (rootExpirationTime !== NoWork) {
    requestWork(root, rootExpirationTime);
  }
  // Flush any sync work that was scheduled by effects
  if (!isBatchingUpdates && !isRendering) {
    performSyncWork();
  }
}

function isAlreadyFailedLegacyErrorBoundary(instance: mixed): boolean {
  return (
    legacyErrorBoundariesThatAlreadyFailed !== null &&
    legacyErrorBoundariesThatAlreadyFailed.has(instance)
  );
}

function markLegacyErrorBoundaryAsFailed(instance: mixed) {
  if (legacyErrorBoundariesThatAlreadyFailed === null) {
    legacyErrorBoundariesThatAlreadyFailed = new Set([instance]);
  } else {
    legacyErrorBoundariesThatAlreadyFailed.add(instance);
  }
}

function flushPassiveEffects() {
  if (passiveEffectCallbackHandle !== null) {
    cancelPassiveEffects(passiveEffectCallbackHandle);
  }
  if (passiveEffectCallback !== null) {
    // We call the scheduled callback instead of commitPassiveEffects directly
    // to ensure tracing works correctly.
    passiveEffectCallback();
  }
}

function commitRoot(
  root: FiberRoot,
  finishedWork: Fiber, // Root的镜像Fiber Node
): void {
  isWorking = true;
  isCommitting = true;
  startCommitTimer();

  invariant(
    root.current !== finishedWork,
    'Cannot commit the same tree as before. This is probably a bug ' +
      'related to the return field. This error is likely caused by a bug ' +
      'in React. Please file an issue.',
  );

  // pendingCommitExpirationTime该值在renderRoot函数最后设置了
  const committedExpirationTime = root.pendingCommitExpirationTime;
  invariant(
    committedExpirationTime !== NoWork,
    'Cannot commit an incomplete root. This error is likely caused by a ' +
      'bug in React. Please file an issue.',
  );
  root.pendingCommitExpirationTime = NoWork;

  // Update the pending priority levels to account for the work that we are
  // about to commit. This needs to happen before calling the lifecycles, since
  // they may schedule additional updates.
  // 更新待处理的优先级
  const updateExpirationTimeBeforeCommit = finishedWork.expirationTime; // 0
  const childExpirationTimeBeforeCommit = finishedWork.childExpirationTime; // 0
  const earliestRemainingTimeBeforeCommit =
    childExpirationTimeBeforeCommit > updateExpirationTimeBeforeCommit
      ? childExpirationTimeBeforeCommit
      : updateExpirationTimeBeforeCommit; // 0

  // 由于是首次渲染, 重置了Fiber Root内部的一些参数, 并学
  markCommittedPriorityLevels(root, earliestRemainingTimeBeforeCommit);

  let prevInteractions: Set<Interaction> = (null: any);
  if (enableSchedulerTracing) {
    // Restore any pending interactions at this point,
    // So that cascading work triggered during the render phase will be accounted for.
    prevInteractions = __interactionsRef.current;
    __interactionsRef.current = root.memoizedInteractions;
  }

  // Reset this to null before calling lifecycles
  ReactCurrentOwner.current = null;

  let firstEffect;
  if (finishedWork.effectTag > PerformedWork) {
    // A fiber's effect list consists only of its children, not itself. So if
    // the root has an effect, we need to add it to the end of the list. The
    // resulting list is the set that would belong to the root's parent, if
    // it had one; that is, all the effects in the tree including the root.
    if (finishedWork.lastEffect !== null) {
      finishedWork.lastEffect.nextEffect = finishedWork; // 
      firstEffect = finishedWork.firstEffect; // Text Fiber Node
    } else {
      firstEffect = finishedWork;
    }
  } else {
    // There is no effect on the root.
    firstEffect = finishedWork.firstEffect;
  }

  // prepareForCommit函数主要是做了下面这些事情
  // eventsEnabled = true
  // selectionInformation = {
  //   focusedElem: 真实DOM元素 body,
  //   selectionRange: null
  // };
  prepareForCommit(root.containerInfo);

  // Invoke instances of getSnapshotBeforeUpdate before mutation.
  nextEffect = firstEffect; // Text Fiber Node
  startCommitSnapshotEffectsTimer();
  while (nextEffect !== null) {
    let didError = false;
    let error;
    if (__DEV__) {
      invokeGuardedCallback(null, commitBeforeMutationLifecycles, null);
      if (hasCaughtError()) {
        didError = true;
        error = clearCaughtError();
      }
    } else {
      try {
        commitBeforeMutationLifecycles();
      } catch (e) {
        didError = true;
        error = e;
      }
    }
    if (didError) {
      invariant(
        nextEffect !== null,
        'Should have next effect. This error is likely caused by a bug ' +
          'in React. Please file an issue.',
      );
      captureCommitPhaseError(nextEffect, error);
      // Clean-up
      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect;
      }
    }
  }

  // 只在dev触发
  stopCommitSnapshotEffectsTimer();
  if (enableProfilerTimer) {
    // Mark the current commit time to be shared by all Profilers in this batch.
    // This enables them to be grouped later.
    recordCommitTime();
  }

  // Commit all the side-effects within a tree. We'll do this in two passes.
  // The first pass performs all the host insertions, updates, deletions and
  // ref unmounts.
  // 在树中提交所有side-effects, 将分两次, 第一遍执行所有插入，更新，删除和ref卸载。
  nextEffect = firstEffect; // Text Fiber Node
  startCommitHostEffectsTimer(); // 记录时间用的, 只在dev触发
  while (nextEffect !== null) {
    let didError = false;
    let error;
    if (__DEV__) {
      invokeGuardedCallback(null, commitAllHostEffects, null);
      if (hasCaughtError()) {
        didError = true;
        error = clearCaughtError();
      }
    } else {
      try {
        commitAllHostEffects();
      } catch (e) {
        didError = true;
        error = e;
      }
    }
    if (didError) {
      invariant(
        nextEffect !== null,
        'Should have next effect. This error is likely caused by a bug ' +
          'in React. Please file an issue.',
      );
      captureCommitPhaseError(nextEffect, error);
      // Clean-up
      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect;
      }
    }
  }
  stopCommitHostEffectsTimer();

  resetAfterCommit(root.containerInfo);

  // The work-in-progress tree is now the current tree. This must come after
  // the first pass of the commit phase, so that the previous tree is still
  // current during componentWillUnmount, but before the second pass, so that
  // the finished work is current during componentDidMount/Update.
  root.current = finishedWork;

  // In the second pass we'll perform all life-cycles and ref callbacks.
  // Life-cycles happen as a separate pass so that all placements, updates,
  // and deletions in the entire tree have already been invoked.
  // This pass also triggers any renderer-specific initial effects.
  // In the second pass，我们将执行所有生命周期和ref回调
  nextEffect = firstEffect;
  startCommitLifeCyclesTimer();
  while (nextEffect !== null) {
    let didError = false;
    let error;
    if (__DEV__) {
      invokeGuardedCallback(
        null,
        commitAllLifeCycles,
        null,
        root,
        committedExpirationTime,
      );
      if (hasCaughtError()) {
        didError = true;
        error = clearCaughtError();
      }
    } else {
      try {
        commitAllLifeCycles(root, committedExpirationTime);
      } catch (e) {
        didError = true;
        error = e;
      }
    }
    if (didError) {
      invariant(
        nextEffect !== null,
        'Should have next effect. This error is likely caused by a bug ' +
          'in React. Please file an issue.',
      );
      captureCommitPhaseError(nextEffect, error);
      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect;
      }
    }
  }

  if (firstEffect !== null && rootWithPendingPassiveEffects !== null) {
    // This commit included a passive effect. These do not need to fire until
    // after the next paint. Schedule an callback to fire them in an async
    // event. To ensure serial execution, the callback will be flushed early if
    // we enter rootWithPendingPassiveEffects commit phase before then.
    let callback = commitPassiveEffects.bind(null, root, firstEffect);
    if (enableSchedulerTracing) {
      // TODO: Avoid this extra callback by mutating the tracing ref directly,
      // like we do at the beginning of commitRoot. I've opted not to do that
      // here because that code is still in flux.
      callback = Scheduler_tracing_wrap(callback);
    }
    passiveEffectCallbackHandle = runWithPriority(NormalPriority, () => {
      return schedulePassiveEffects(callback);
    });
    passiveEffectCallback = callback;
  }

  isCommitting = false;
  isWorking = false;
  stopCommitLifeCyclesTimer();
  stopCommitTimer();
  onCommitRoot(finishedWork.stateNode);
  if (__DEV__ && ReactFiberInstrumentation.debugTool) {
    ReactFiberInstrumentation.debugTool.onCommitWork(finishedWork);
  }

  const updateExpirationTimeAfterCommit = finishedWork.expirationTime;
  const childExpirationTimeAfterCommit = finishedWork.childExpirationTime;
  const earliestRemainingTimeAfterCommit =
    childExpirationTimeAfterCommit > updateExpirationTimeAfterCommit
      ? childExpirationTimeAfterCommit
      : updateExpirationTimeAfterCommit;
  if (earliestRemainingTimeAfterCommit === NoWork) {
    // If there's no remaining work, we can clear the set of already failed
    // error boundaries.
    legacyErrorBoundariesThatAlreadyFailed = null;
  }
  onCommit(root, earliestRemainingTimeAfterCommit);

  if (enableSchedulerTracing) {
    __interactionsRef.current = prevInteractions;

    let subscriber;

    try {
      subscriber = __subscriberRef.current;
      if (subscriber !== null && root.memoizedInteractions.size > 0) {
        const threadID = computeThreadID(
          committedExpirationTime,
          root.interactionThreadID,
        );
        subscriber.onWorkStopped(root.memoizedInteractions, threadID);
      }
    } catch (error) {
      // It's not safe for commitRoot() to throw.
      // Store the error for now and we'll re-throw in finishRendering().
      if (!hasUnhandledError) {
        hasUnhandledError = true;
        unhandledError = error;
      }
    } finally {
      // Clear completed interactions from the pending Map.
      // Unless the render was suspended or cascading work was scheduled,
      // In which case– leave pending interactions until the subsequent render.
      const pendingInteractionMap = root.pendingInteractionMap;
      pendingInteractionMap.forEach(
        (scheduledInteractions, scheduledExpirationTime) => {
          // Only decrement the pending interaction count if we're done.
          // If there's still work at the current priority,
          // That indicates that we are waiting for suspense data.
          if (scheduledExpirationTime > earliestRemainingTimeAfterCommit) {
            pendingInteractionMap.delete(scheduledExpirationTime);

            scheduledInteractions.forEach(interaction => {
              interaction.__count--;

              if (subscriber !== null && interaction.__count === 0) {
                try {
                  subscriber.onInteractionScheduledWorkCompleted(interaction);
                } catch (error) {
                  // It's not safe for commitRoot() to throw.
                  // Store the error for now and we'll re-throw in finishRendering().
                  if (!hasUnhandledError) {
                    hasUnhandledError = true;
                    unhandledError = error;
                  }
                }
              }
            });
          }
        },
      );
    }
  }
}

function resetChildExpirationTime(
  workInProgress: Fiber,
  renderTime: ExpirationTime,
) {
  if (renderTime !== Never && workInProgress.childExpirationTime === Never) {
    // The children of this component are hidden. Don't bubble their
    // expiration times.
    return;
  }

  let newChildExpirationTime = NoWork;

  // Bubble up the earliest expiration time.
  if (enableProfilerTimer && workInProgress.mode & ProfileMode) {
    // We're in profiling mode.
    // Let's use this same traversal to update the render durations.
    let actualDuration = workInProgress.actualDuration;
    let treeBaseDuration = workInProgress.selfBaseDuration;

    // When a fiber is cloned, its actualDuration is reset to 0.
    // This value will only be updated if work is done on the fiber (i.e. it doesn't bailout).
    // When work is done, it should bubble to the parent's actualDuration.
    // If the fiber has not been cloned though, (meaning no work was done),
    // Then this value will reflect the amount of time spent working on a previous render.
    // In that case it should not bubble.
    // We determine whether it was cloned by comparing the child pointer.
    const shouldBubbleActualDurations =
      workInProgress.alternate === null ||
      workInProgress.child !== workInProgress.alternate.child;

    let child = workInProgress.child;
    while (child !== null) {
      const childUpdateExpirationTime = child.expirationTime;
      const childChildExpirationTime = child.childExpirationTime;
      if (childUpdateExpirationTime > newChildExpirationTime) {
        newChildExpirationTime = childUpdateExpirationTime;
      }
      if (childChildExpirationTime > newChildExpirationTime) {
        newChildExpirationTime = childChildExpirationTime;
      }
      if (shouldBubbleActualDurations) {
        actualDuration += child.actualDuration;
      }
      treeBaseDuration += child.treeBaseDuration;
      child = child.sibling;
    }
    workInProgress.actualDuration = actualDuration;
    workInProgress.treeBaseDuration = treeBaseDuration;
  } else {
    let child = workInProgress.child;
    while (child !== null) {
      const childUpdateExpirationTime = child.expirationTime;
      const childChildExpirationTime = child.childExpirationTime;
      if (childUpdateExpirationTime > newChildExpirationTime) {
        newChildExpirationTime = childUpdateExpirationTime;
      }
      if (childChildExpirationTime > newChildExpirationTime) {
        newChildExpirationTime = childChildExpirationTime;
      }
      child = child.sibling;
    }
  }

  workInProgress.childExpirationTime = newChildExpirationTime;
}

function completeUnitOfWork(workInProgress: Fiber): Fiber | null {
  // Attempt to complete the current unit of work, then move to the
  // next sibling. If there are no more siblings, return to the
  // parent fiber.
  // 尝试完成当前的工作单元，然后转到下一个兄弟。 如果没有兄弟，返回parent fiber。
  while (true) {
    // The current, flushed, state of this fiber is the alternate.
    // Ideally nothing should rely on this, but relying on it here
    // means that we don't need an additional field on the work in
    // progress.
    // 理想情况下，没有什么可以依赖于current，但在此依赖它意味着我们在正在进行的工作中不需要额外的字段

    // 注意此时触发这个函数的Fiber是Text FiberNode, 它没有alternate
    const current = workInProgress.alternate; // null
    if (__DEV__) {
      setCurrentFiber(workInProgress);
    }

    const returnFiber = workInProgress.return; // parent Fiber, 参考上一小节总结的那个图
    const siblingFiber = workInProgress.sibling; // null

    // Incomplete是常量值为0b010000000000
    // NoEffect是常量值为0b000000000000
    if ((workInProgress.effectTag & Incomplete) === NoEffect) {
      if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
        // Don't replay if it fails during completion phase.
        mayReplayFailedUnitOfWork = false;
      }
      // This fiber completed.
      // Remember we're completing this unit so we can find a boundary if it fails.
      nextUnitOfWork = workInProgress;
      if (enableProfilerTimer) {
        if (workInProgress.mode & ProfileMode) {
          startProfilerTimer(workInProgress);
        }
        nextUnitOfWork = completeWork(
          current,
          workInProgress,
          nextRenderExpirationTime,
        );
        if (workInProgress.mode & ProfileMode) {
          // Update render duration assuming we didn't error.
          stopProfilerTimerIfRunningAndRecordDelta(workInProgress, false);
        }
      } else {
        nextUnitOfWork = completeWork(
          current,
          workInProgress,
          nextRenderExpirationTime,
        );
      }
      if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
        // We're out of completion phase so replaying is fine now.
        mayReplayFailedUnitOfWork = true;
      }
      stopWorkTimer(workInProgress);
      // 更新当前Fiber的childExpirationTime
      resetChildExpirationTime(workInProgress, nextRenderExpirationTime);
      if (__DEV__) {
        resetCurrentFiber();
      }

      if (nextUnitOfWork !== null) {
        // Completing this fiber spawned new work. Work on that next.
        return nextUnitOfWork;
      }

      if (
        returnFiber !== null &&
        // Do not append effects to parents if a sibling failed to complete
        (returnFiber.effectTag & Incomplete) === NoEffect
      ) {
        // Append all the effects of the subtree and this fiber onto the effect
        // list of the parent. The completion order of the children affects the
        // side-effect order.
        if (returnFiber.firstEffect === null) {
          returnFiber.firstEffect = workInProgress.firstEffect;
        }
        if (workInProgress.lastEffect !== null) {
          if (returnFiber.lastEffect !== null) {
            returnFiber.lastEffect.nextEffect = workInProgress.firstEffect;
          }
          returnFiber.lastEffect = workInProgress.lastEffect;
        }

        // If this fiber had side-effects, we append it AFTER the children's
        // side-effects. We can perform certain side-effects earlier if
        // needed, by doing multiple passes over the effect list. We don't want
        // to schedule our own side-effect on our own list because if end up
        // reusing children we'll schedule this effect onto itself since we're
        // at the end.
        const effectTag = workInProgress.effectTag;
        // Skip both NoWork and PerformedWork tags when creating the effect list.
        // PerformedWork effect is read by React DevTools but shouldn't be committed.
        if (effectTag > PerformedWork) {
          if (returnFiber.lastEffect !== null) {
            returnFiber.lastEffect.nextEffect = workInProgress;
          } else {
            returnFiber.firstEffect = workInProgress;
          }
          returnFiber.lastEffect = workInProgress;
        }
      }

      if (__DEV__ && ReactFiberInstrumentation.debugTool) {
        ReactFiberInstrumentation.debugTool.onCompleteWork(workInProgress);
      }

      if (siblingFiber !== null) {
        // If there is more work to do in this returnFiber, do that next.
        return siblingFiber;
      } else if (returnFiber !== null) {
        // If there's no more work in this returnFiber. Complete the returnFiber.
        workInProgress = returnFiber;
        continue;
      } else {
        // We've reached the root.
        return null;
      }
    } else {
      if (enableProfilerTimer && workInProgress.mode & ProfileMode) {
        // Record the render duration for the fiber that errored.
        stopProfilerTimerIfRunningAndRecordDelta(workInProgress, false);

        // Include the time spent working on failed children before continuing.
        let actualDuration = workInProgress.actualDuration;
        let child = workInProgress.child;
        while (child !== null) {
          actualDuration += child.actualDuration;
          child = child.sibling;
        }
        workInProgress.actualDuration = actualDuration;
      }

      // This fiber did not complete because something threw. Pop values off
      // the stack without entering the complete phase. If this is a boundary,
      // capture values if possible.
      const next = unwindWork(workInProgress, nextRenderExpirationTime);
      // Because this fiber did not complete, don't reset its expiration time.
      if (workInProgress.effectTag & DidCapture) {
        // Restarting an error boundary
        stopFailedWorkTimer(workInProgress);
      } else {
        stopWorkTimer(workInProgress);
      }

      if (__DEV__) {
        resetCurrentFiber();
      }

      if (next !== null) {
        stopWorkTimer(workInProgress);
        if (__DEV__ && ReactFiberInstrumentation.debugTool) {
          ReactFiberInstrumentation.debugTool.onCompleteWork(workInProgress);
        }

        // If completing this work spawned new work, do that next. We'll come
        // back here again.
        // Since we're restarting, remove anything that is not a host effect
        // from the effect tag.
        next.effectTag &= HostEffectMask;
        return next;
      }

      if (returnFiber !== null) {
        // Mark the parent fiber as incomplete and clear its effect list.
        returnFiber.firstEffect = returnFiber.lastEffect = null;
        returnFiber.effectTag |= Incomplete;
      }

      if (__DEV__ && ReactFiberInstrumentation.debugTool) {
        ReactFiberInstrumentation.debugTool.onCompleteWork(workInProgress);
      }

      if (siblingFiber !== null) {
        // If there is more work to do in this returnFiber, do that next.
        return siblingFiber;
      } else if (returnFiber !== null) {
        // If there's no more work in this returnFiber. Complete the returnFiber.
        workInProgress = returnFiber;
        continue;
      } else {
        return null;
      }
    }
  }

  // Without this explicit null return Flow complains of invalid return type
  // TODO Remove the above while(true) loop
  // eslint-disable-next-line no-unreachable
  return null;
}

function performUnitOfWork(workInProgress: Fiber): Fiber | null {
  // The current, flushed, state of this fiber is the alternate.
  // Ideally nothing should rely on this, but relying on it here
  // means that we don't need an additional field on the work in
  // progress.
  // 这时候不需要继续使用镜像Fiber了, 指回来
  // 理想情况下，没有什么可以依赖于此，但在此依赖它意味着我们在正在进行的工作中不需要额外的字段。
  const current = workInProgress.alternate;

  // See if beginning this work spawns more work.
  // 以下两个函数均只在_dev_环境下触发
  startWorkTimer(workInProgress);
  if (__DEV__) {
    // 设置当前FiberNode到current变量上
    setCurrentFiber(workInProgress);
  }

  if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
    stashedWorkInProgressProperties = assignFiberPropertiesInDEV(
      stashedWorkInProgressProperties,
      workInProgress,
    );
  }

  let next;
  if (enableProfilerTimer) {
    if (workInProgress.mode & ProfileMode) {
      startProfilerTimer(workInProgress);
    }

    next = beginWork(current, workInProgress, nextRenderExpirationTime);
    workInProgress.memoizedProps = workInProgress.pendingProps;

    if (workInProgress.mode & ProfileMode) {
      // Record the render duration assuming we didn't bailout (or error).
      stopProfilerTimerIfRunningAndRecordDelta(workInProgress, true);
    }
  } else {
    next = beginWork(current, workInProgress, nextRenderExpirationTime);
    workInProgress.memoizedProps = workInProgress.pendingProps;
  }

  if (__DEV__) {
    resetCurrentFiber();
    if (isReplayingFailedUnitOfWork) {
      // Currently replaying a failed unit of work. This should be unreachable,
      // because the render phase is meant to be idempotent, and it should
      // have thrown again. Since it didn't, rethrow the original error, so
      // React's internal stack is not misaligned.
      rethrowOriginalError();
    }
  }
  if (__DEV__ && ReactFiberInstrumentation.debugTool) {
    ReactFiberInstrumentation.debugTool.onBeginWork(workInProgress);
  }

  if (next === null) {
    // If this doesn't spawn new work, complete the current work.
    // 如果这不产生新的工作, 就完成当前的工作
    next = completeUnitOfWork(workInProgress);
  }

  ReactCurrentOwner.current = null;

  return next;
}

function workLoop(
  isYieldy, // false
) {
  if (!isYieldy) {
    // Flush work without yielding

    // nextUnitOfWork为FiberNode
    while (nextUnitOfWork !== null) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
    }
  } else {
    // Flush asynchronous work until there's a higher priority event
    while (nextUnitOfWork !== null && !shouldYieldToRenderer()) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
    }
  }
}

function renderRoot(
  root: FiberRoot,
  isYieldy: boolean, // false
): void {
  invariant(
    !isWorking,
    'renderRoot was called recursively. This error is likely caused ' +
    'by a bug in React. Please file an issue.',
  );

  flushPassiveEffects();

  isWorking = true; // 用来标志当前是否有工作正在执行
  const previousDispatcher = ReactCurrentDispatcher.current; // null
  ReactCurrentDispatcher.current = ContextOnlyDispatcher;

  const expirationTime = root.nextExpirationTimeToWorkOn; // 1.4.2.1 findNextExpirationTimeToWorkOn的这个函数设置的Sync

  // Check if we're starting from a fresh stack, or if we're resuming from
  // previously yielded work.
  // nextRenderExpirationTime为变量值为0
  if (
    expirationTime !== nextRenderExpirationTime ||
    root !== nextRoot ||
    nextUnitOfWork === null
  ) {
    // Reset the stack and start working from the root.
    resetStack();
    // resetStack只要把以下变量重置了:
    /**
      nextRoot = null;
      nextRenderExpirationTime = NoWork;
      nextLatestAbsoluteTimeoutMs = -1;
      nextRenderDidError = false;
      nextUnitOfWork = null;
    */
    nextRoot = root;
    nextRenderExpirationTime = expirationTime;
    nextUnitOfWork = createWorkInProgress(
      nextRoot.current, // FiberNode
      null,
      nextRenderExpirationTime, // Sync
    ); // 创建镜像fiber, 返回FiberNode
    root.pendingCommitExpirationTime = NoWork; // 0

    // 跟踪每个交互触发的每个commit.
    // 这一期不看, 没有任何交互就是React.render('', dom)
    if (enableSchedulerTracing) {
      // Determine which interactions this batch of work currently includes,
      // So that we can accurately attribute time spent working on it,
      // And so that cascading work triggered during the render phase will be associated with it.
      const interactions: Set<Interaction> = new Set();
      root.pendingInteractionMap.forEach(
        (scheduledInteractions, scheduledExpirationTime) => {
          if (scheduledExpirationTime >= expirationTime) {
            scheduledInteractions.forEach(interaction =>
              interactions.add(interaction),
            );
          }
        },
      );

      // Store the current set of interactions on the FiberRoot for a few reasons:
      // We can re-use it in hot functions like renderRoot() without having to recalculate it.
      // We will also use it in commitWork() to pass to any Profiler onRender() hooks.
      // This also provides DevTools with a way to access it when the onCommitRoot() hook is called.
      root.memoizedInteractions = interactions;

      if (interactions.size > 0) {
        const subscriber = __subscriberRef.current;
        if (subscriber !== null) {
          const threadID = computeThreadID(
            expirationTime,
            root.interactionThreadID,
          );
          try {
            subscriber.onWorkStarted(interactions, threadID);
          } catch (error) {
            // Work thrown by an interaction tracing subscriber should be rethrown,
            // But only once it's safe (to avoid leaving the scheduler in an invalid state).
            // Store the error for now and we'll re-throw in finishRendering().
            if (!hasUnhandledError) {
              hasUnhandledError = true;
              unhandledError = error;
            }
          }
        }
      }
    }
  }

  let prevInteractions: Set<Interaction> = (null: any);
  if (enableSchedulerTracing) {
    // We're about to start new traced work.
    // Restore pending interactions so cascading work triggered during the render phase will be accounted for.
    prevInteractions = __interactionsRef.current;
    __interactionsRef.current = root.memoizedInteractions;
  }

  let didFatal = false;

  // 此函数只在dev环境执行, 使用performance.mark搞个时间戳
  startWorkLoopTimer(nextUnitOfWork);

  do {
    try {
      workLoop(isYieldy);
    } catch (thrownValue) {
      resetContextDependences();
      resetHooks();

      // Reset in case completion throws.
      // This is only used in DEV and when replaying is on.
      let mayReplay;
      if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
        mayReplay = mayReplayFailedUnitOfWork;
        mayReplayFailedUnitOfWork = true;
      }

      if (nextUnitOfWork === null) {
        // This is a fatal error.
        didFatal = true;
        onUncaughtError(thrownValue);
      } else {
        if (enableProfilerTimer && nextUnitOfWork.mode & ProfileMode) {
          // Record the time spent rendering before an error was thrown.
          // This avoids inaccurate Profiler durations in the case of a suspended render.
          stopProfilerTimerIfRunningAndRecordDelta(nextUnitOfWork, true);
        }

        if (__DEV__) {
          // Reset global debug state
          // We assume this is defined in DEV
          (resetCurrentlyProcessingQueue: any)();
        }

        if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
          if (mayReplay) {
            const failedUnitOfWork: Fiber = nextUnitOfWork;
            replayUnitOfWork(failedUnitOfWork, thrownValue, isYieldy);
          }
        }

        // TODO: we already know this isn't true in some cases.
        // At least this shows a nicer error message until we figure out the cause.
        // https://github.com/facebook/react/issues/12449#issuecomment-386727431
        invariant(
          nextUnitOfWork !== null,
          'Failed to replay rendering after an error. This ' +
            'is likely caused by a bug in React. Please file an issue ' +
            'with a reproducing case to help us find it.',
        );

        const sourceFiber: Fiber = nextUnitOfWork;
        let returnFiber = sourceFiber.return;
        if (returnFiber === null) {
          // This is the root. The root could capture its own errors. However,
          // we don't know if it errors before or after we pushed the host
          // context. This information is needed to avoid a stack mismatch.
          // Because we're not sure, treat this as a fatal error. We could track
          // which phase it fails in, but doesn't seem worth it. At least
          // for now.
          didFatal = true;
          onUncaughtError(thrownValue);
        } else {
          throwException(
            root,
            returnFiber,
            sourceFiber,
            thrownValue,
            nextRenderExpirationTime,
          );
          nextUnitOfWork = completeUnitOfWork(sourceFiber);
          continue;
        }
      }
    }
    break;
  } while (true);

  if (enableSchedulerTracing) {
    // Traced work is done for now; restore the previous interactions.
    __interactionsRef.current = prevInteractions;
  }

  // We're done performing work. Time to clean up.
  isWorking = false;
  ReactCurrentDispatcher.current = previousDispatcher;
  resetContextDependences();
  resetHooks();

  // Yield back to main thread.
  if (didFatal) {
    const didCompleteRoot = false;
    stopWorkLoopTimer(interruptedBy, didCompleteRoot);
    interruptedBy = null;
    // There was a fatal error.
    if (__DEV__) {
      resetStackAfterFatalErrorInDev();
    }
    // `nextRoot` points to the in-progress root. A non-null value indicates
    // that we're in the middle of an async render. Set it to null to indicate
    // there's no more work to be done in the current batch.
    nextRoot = null;
    onFatal(root);
    return;
  }

  if (nextUnitOfWork !== null) {
    // There's still remaining async work in this tree, but we ran out of time
    // in the current frame. Yield back to the renderer. Unless we're
    // interrupted by a higher priority update, we'll continue later from where
    // we left off.
    const didCompleteRoot = false;
    stopWorkLoopTimer(interruptedBy, didCompleteRoot);
    interruptedBy = null;
    onYield(root);
    return;
  }

  // We completed the whole tree.
  const didCompleteRoot = true;
  stopWorkLoopTimer(interruptedBy, didCompleteRoot);
  const rootWorkInProgress = root.current.alternate;
  invariant(
    rootWorkInProgress !== null,
    'Finished root should have a work-in-progress. This error is likely ' +
      'caused by a bug in React. Please file an issue.',
  );

  // `nextRoot` points to the in-progress root. A non-null value indicates
  // that we're in the middle of an async render. Set it to null to indicate
  // there's no more work to be done in the current batch.
  nextRoot = null;
  interruptedBy = null;

  if (nextRenderDidError) {
    // There was an error
    if (hasLowerPriorityWork(root, expirationTime)) {
      // There's lower priority work. If so, it may have the effect of fixing
      // the exception that was just thrown. Exit without committing. This is
      // similar to a suspend, but without a timeout because we're not waiting
      // for a promise to resolve. React will restart at the lower
      // priority level.
      markSuspendedPriorityLevel(root, expirationTime);
      const suspendedExpirationTime = expirationTime;
      const rootExpirationTime = root.expirationTime;
      onSuspend(
        root,
        rootWorkInProgress,
        suspendedExpirationTime,
        rootExpirationTime,
        -1, // Indicates no timeout
      );
      return;
    } else if (
      // There's no lower priority work, but we're rendering asynchronously.
      // Synchronously attempt to render the same level one more time. This is
      // similar to a suspend, but without a timeout because we're not waiting
      // for a promise to resolve.
      !root.didError &&
      isYieldy
    ) {
      root.didError = true;
      const suspendedExpirationTime = (root.nextExpirationTimeToWorkOn = expirationTime);
      const rootExpirationTime = (root.expirationTime = Sync);
      onSuspend(
        root,
        rootWorkInProgress,
        suspendedExpirationTime,
        rootExpirationTime,
        -1, // Indicates no timeout
      );
      return;
    }
  }

  if (isYieldy && nextLatestAbsoluteTimeoutMs !== -1) {
    // The tree was suspended.
    const suspendedExpirationTime = expirationTime;
    markSuspendedPriorityLevel(root, suspendedExpirationTime);

    // Find the earliest uncommitted expiration time in the tree, including
    // work that is suspended. The timeout threshold cannot be longer than
    // the overall expiration.
    const earliestExpirationTime = findEarliestOutstandingPriorityLevel(
      root,
      expirationTime,
    );
    const earliestExpirationTimeMs = expirationTimeToMs(earliestExpirationTime);
    if (earliestExpirationTimeMs < nextLatestAbsoluteTimeoutMs) {
      nextLatestAbsoluteTimeoutMs = earliestExpirationTimeMs;
    }

    // Subtract the current time from the absolute timeout to get the number
    // of milliseconds until the timeout. In other words, convert an absolute
    // timestamp to a relative time. This is the value that is passed
    // to `setTimeout`.
    const currentTimeMs = expirationTimeToMs(requestCurrentTime());
    let msUntilTimeout = nextLatestAbsoluteTimeoutMs - currentTimeMs;
    msUntilTimeout = msUntilTimeout < 0 ? 0 : msUntilTimeout;

    // TODO: Account for the Just Noticeable Difference

    const rootExpirationTime = root.expirationTime;
    onSuspend(
      root,
      rootWorkInProgress,
      suspendedExpirationTime,
      rootExpirationTime,
      msUntilTimeout,
    );
    return;
  }

  // Ready to commit.
  onComplete(root, rootWorkInProgress, expirationTime);
}

function captureCommitPhaseError(sourceFiber: Fiber, value: mixed) {
  const expirationTime = Sync;
  let fiber = sourceFiber.return;
  while (fiber !== null) {
    switch (fiber.tag) {
      case ClassComponent:
        const ctor = fiber.type;
        const instance = fiber.stateNode;
        if (
          typeof ctor.getDerivedStateFromError === 'function' ||
          (typeof instance.componentDidCatch === 'function' &&
            !isAlreadyFailedLegacyErrorBoundary(instance))
        ) {
          const errorInfo = createCapturedValue(value, sourceFiber);
          const update = createClassErrorUpdate(
            fiber,
            errorInfo,
            expirationTime,
          );
          enqueueUpdate(fiber, update);
          scheduleWork(fiber, expirationTime);
          return;
        }
        break;
      case HostRoot: {
        const errorInfo = createCapturedValue(value, sourceFiber);
        const update = createRootErrorUpdate(fiber, errorInfo, expirationTime);
        enqueueUpdate(fiber, update);
        scheduleWork(fiber, expirationTime);
        return;
      }
    }
    fiber = fiber.return;
  }

  if (sourceFiber.tag === HostRoot) {
    // Error was thrown at the root. There is no parent, so the root
    // itself should capture it.
    const rootFiber = sourceFiber;
    const errorInfo = createCapturedValue(value, rootFiber);
    const update = createRootErrorUpdate(rootFiber, errorInfo, expirationTime);
    enqueueUpdate(rootFiber, update);
    scheduleWork(rootFiber, expirationTime);
  }
}

function computeThreadID(
  expirationTime: ExpirationTime,
  interactionThreadID: number,
): number {
  // Interaction threads are unique per root and expiration time.
  return expirationTime * 1000 + interactionThreadID;
}

// Creates a unique async expiration time.
function computeUniqueAsyncExpiration(): ExpirationTime {
  const currentTime = requestCurrentTime();
  let result = computeAsyncExpiration(currentTime);
  if (result >= lastUniqueAsyncExpiration) {
    // Since we assume the current time monotonically increases, we only hit
    // this branch when computeUniqueAsyncExpiration is fired multiple times
    // within a 200ms window (or whatever the async bucket size is).
    result = lastUniqueAsyncExpiration - 1;
  }
  lastUniqueAsyncExpiration = result;
  return lastUniqueAsyncExpiration;
}

function computeExpirationForFiber(
  currentTime: ExpirationTime, // requestCurrentTime算得的时间
  fiber: Fiber, // FiberNode
) {
  const priorityLevel = getCurrentPriorityLevel(); // 初始返回NormalPriority => 3

  let expirationTime;
  // ConcurrentMode是常量为0b001
  // NoContext是常量为0b000
  // fiber.mode 为 0
  if ((fiber.mode & ConcurrentMode) === NoContext) {
    // Outside of concurrent mode, updates are always synchronous.
    // 在并发模式之外，更新始终是同步的
    // Sync是常量, 值为32位系统的V8中的最大整数, Math.pow(2, 30) - 1
    expirationTime = Sync;
  } else if (isWorking && !isCommitting) {
    // During render phase, updates expire during as the current render.
    // 在render阶段
    expirationTime = nextRenderExpirationTime;
  } else {
    switch (priorityLevel) {
      case ImmediatePriority:
        expirationTime = Sync;
        break;
      case UserBlockingPriority:
        expirationTime = computeInteractiveExpiration(currentTime);
        break;
      case NormalPriority:
        // This is a normal, concurrent update
        expirationTime = computeAsyncExpiration(currentTime);
        break;
      case LowPriority:
      case IdlePriority:
        expirationTime = Never;
        break;
      default:
        invariant(
          false,
          'Unknown priority level. This error is likely caused by a bug in ' +
            'React. Please file an issue.',
        );
    }

    // If we're in the middle of rendering a tree, do not update at the same
    // expiration time that is already rendering.
    // 如果正在rendering tree, 不要更新过期时间
    if (nextRoot !== null && expirationTime === nextRenderExpirationTime) {
      expirationTime -= 1;
    }
  }

  // Keep track of the lowest pending interactive expiration time. This
  // allows us to synchronously flush all interactive updates
  // when needed.
  // TODO: Move this to renderer?
  if (
    priorityLevel === UserBlockingPriority &&
    (lowestPriorityPendingInteractiveExpirationTime === NoWork ||
      expirationTime < lowestPriorityPendingInteractiveExpirationTime)
  ) {
    lowestPriorityPendingInteractiveExpirationTime = expirationTime;
  }

  return expirationTime;
}

function renderDidSuspend(
  root: FiberRoot,
  absoluteTimeoutMs: number,
  suspendedTime: ExpirationTime,
) {
  // Schedule the timeout.
  if (
    absoluteTimeoutMs >= 0 &&
    nextLatestAbsoluteTimeoutMs < absoluteTimeoutMs
  ) {
    nextLatestAbsoluteTimeoutMs = absoluteTimeoutMs;
  }
}

function renderDidError() {
  nextRenderDidError = true;
}

function pingSuspendedRoot(
  root: FiberRoot,
  thenable: Thenable,
  pingTime: ExpirationTime,
) {
  // A promise that previously suspended React from committing has resolved.
  // If React is still suspended, try again at the previous level (pingTime).

  const pingCache = root.pingCache;
  if (pingCache !== null) {
    // The thenable resolved, so we no longer need to memoize, because it will
    // never be thrown again.
    pingCache.delete(thenable);
  }

  if (nextRoot !== null && nextRenderExpirationTime === pingTime) {
    // Received a ping at the same priority level at which we're currently
    // rendering. Restart from the root.
    nextRoot = null;
  } else {
    // Confirm that the root is still suspended at this level. Otherwise exit.
    if (isPriorityLevelSuspended(root, pingTime)) {
      // Ping at the original level
      markPingedPriorityLevel(root, pingTime);
      const rootExpirationTime = root.expirationTime;
      if (rootExpirationTime !== NoWork) {
        requestWork(root, rootExpirationTime);
      }
    }
  }
}

function retryTimedOutBoundary(boundaryFiber: Fiber, thenable: Thenable) {
  // The boundary fiber (a Suspense component) previously timed out and was
  // rendered in its fallback state. One of the promises that suspended it has
  // resolved, which means at least part of the tree was likely unblocked. Try
  // rendering again, at a new expiration time.

  let retryCache: WeakSet<Thenable> | Set<Thenable> | null;
  if (enableSuspenseServerRenderer) {
    switch (boundaryFiber.tag) {
      case SuspenseComponent:
        retryCache = boundaryFiber.stateNode;
        break;
      case DehydratedSuspenseComponent:
        retryCache = boundaryFiber.memoizedState;
        break;
      default:
        invariant(
          false,
          'Pinged unknown suspense boundary type. ' +
            'This is probably a bug in React.',
        );
    }
  } else {
    retryCache = boundaryFiber.stateNode;
  }
  if (retryCache !== null) {
    // The thenable resolved, so we no longer need to memoize, because it will
    // never be thrown again.
    retryCache.delete(thenable);
  }

  const currentTime = requestCurrentTime();
  const retryTime = computeExpirationForFiber(currentTime, boundaryFiber);
  const root = scheduleWorkToRoot(boundaryFiber, retryTime);
  if (root !== null) {
    markPendingPriorityLevel(root, retryTime);
    const rootExpirationTime = root.expirationTime;
    if (rootExpirationTime !== NoWork) {
      requestWork(root, rootExpirationTime);
    }
  }
}

function scheduleWorkToRoot(
  fiber: Fiber, // FiberNode
  expirationTime, // requestCurrentTime算得的时间
): FiberRoot | null {
  recordScheduleUpdate(); // 只有dev环境运行

  if (__DEV__) {
    // ClassComponent是常量值为1
    if (fiber.tag === ClassComponent) {
      const instance = fiber.stateNode;
      // 警告操作不要在getChildContext(已弃用)和render中使用setState
      warnAboutInvalidUpdates(instance);
    }
  }

  // Update the source fiber's expiration time
  if (fiber.expirationTime < expirationTime) {
    fiber.expirationTime = expirationTime; // 更新一下
  }
  let alternate = fiber.alternate; // 镜像fiber, 这时候还没
  if (alternate !== null && alternate.expirationTime < expirationTime) {
    alternate.expirationTime = expirationTime;
  }
  // Walk the parent path to the root and update the child expiration time.
  let node = fiber.return; // 指向当前fiber的父级
  let root = null;
  if (node === null && fiber.tag === HostRoot) {
    root = fiber.stateNode; // FiberRoot
  } else {
    // 当前节点所有父节点过期时间都更新一下
    while (node !== null) {
      alternate = node.alternate;
      if (node.childExpirationTime < expirationTime) {
        node.childExpirationTime = expirationTime;
        if (
          alternate !== null &&
          alternate.childExpirationTime < expirationTime
        ) {
          alternate.childExpirationTime = expirationTime;
        }
      } else if (
        alternate !== null &&
        alternate.childExpirationTime < expirationTime
      ) {
        alternate.childExpirationTime = expirationTime;
      }
      if (node.return === null && node.tag === HostRoot) {
        // 到跟节点退出
        root = node.stateNode;
        break;
      }
      node = node.return;
    }
  }

  if (enableSchedulerTracing) {
    if (root !== null) {
      // __interactionsRef里面就一个current, 其数据类型为SET
      const interactions = __interactionsRef.current;
      if (interactions.size > 0) {
        const pendingInteractionMap = root.pendingInteractionMap;
        const pendingInteractions = pendingInteractionMap.get(expirationTime);
        if (pendingInteractions != null) {
          interactions.forEach(interaction => {
            if (!pendingInteractions.has(interaction)) {
              // Update the pending async work count for previously unscheduled interaction.
              interaction.__count++;
            }

            pendingInteractions.add(interaction);
          });
        } else {
          pendingInteractionMap.set(expirationTime, new Set(interactions));

          // Update the pending async work count for the current interactions.
          interactions.forEach(interaction => {
            interaction.__count++;
          });
        }

        const subscriber = __subscriberRef.current;
        if (subscriber !== null) {
          const threadID = computeThreadID(
            expirationTime,
            root.interactionThreadID,
          );
          subscriber.onWorkScheduled(interactions, threadID);
        }
      }
    }
  }
  return root;
}

export function warnIfNotCurrentlyBatchingInDev(fiber: Fiber): void {
  if (__DEV__) {
    if (isRendering === false && isBatchingUpdates === false) {
      warningWithoutStack(
        false,
        'An update to %s inside a test was not wrapped in act(...).\n\n' +
          'When testing, code that causes React state updates should be wrapped into act(...):\n\n' +
          'act(() => {\n' +
          '  /* fire events that update state */\n' +
          '});\n' +
          '/* assert on the output */\n\n' +
          "This ensures that you're testing the behavior the user would see in the browser." +
          ' Learn more at https://fb.me/react-wrap-tests-with-act' +
          '%s',
        getComponentName(fiber.type),
        getStackByFiberInDevAndProd(fiber),
      );
    }
  }
}

function scheduleWork(
  fiber: Fiber, // FiberNode
  expirationTime: ExpirationTime, // requestCurrentTime算得的时间
) {
  const root = scheduleWorkToRoot(fiber, expirationTime); // 返回的是FiberRoot
  if (root === null) {
    if (__DEV__) {
      switch (fiber.tag) {
        case ClassComponent:
          warnAboutUpdateOnUnmounted(fiber, true);
          break;
        case FunctionComponent:
        case ForwardRef:
        case MemoComponent:
        case SimpleMemoComponent:
          warnAboutUpdateOnUnmounted(fiber, false);
          break;
      }
    }
    return;
  }

  // isWorking是变量, 初始值为false
  // NoWork是常量值为0
  // nextRenderExpirationTime是变量, 初始值为NoWork
  if (
    !isWorking &&
    nextRenderExpirationTime !== NoWork &&
    expirationTime > nextRenderExpirationTime
  ) { // 初次不会到这次循环内
    // This is an interruption. (Used for performance tracking.)
    // 这是一次中断, 用于性能追踪
    interruptedBy = fiber;
    resetStack();
  }
  markPendingPriorityLevel(root, expirationTime);
  if (
    // If we're in the render phase, we don't need to schedule this root
    // for an update, because we'll do it before we exit...
    !isWorking ||
    isCommitting ||
    // ...unless this is a different root than the one we're rendering.
    nextRoot !== root
  ) {
    // 进到这里了
    const rootExpirationTime = root.expirationTime;
    requestWork(root, rootExpirationTime);
  }
  if (nestedUpdateCount > NESTED_UPDATE_LIMIT) {
    // Reset this back to zero so subsequent updates don't throw.
    nestedUpdateCount = 0;
    invariant(
      false,
      'Maximum update depth exceeded. This can happen when a ' +
        'component repeatedly calls setState inside ' +
        'componentWillUpdate or componentDidUpdate. React limits ' +
        'the number of nested updates to prevent infinite loops.',
    );
  }
}

function syncUpdates<A, B, C0, D, R>(
  fn: (A, B, C0, D) => R,
  a: A,
  b: B,
  c: C0,
  d: D,
): R {
  return runWithPriority(ImmediatePriority, () => {
    return fn(a, b, c, d);
  });
}

// TODO: Everything below this is written as if it has been lifted to the
// renderers. I'll do this in a follow-up.

// Linked-list of roots
let firstScheduledRoot: FiberRoot | null = null;
let lastScheduledRoot: FiberRoot | null = null;

let callbackExpirationTime: ExpirationTime = NoWork;
let callbackID: *;
let isRendering: boolean = false;
let nextFlushedRoot: FiberRoot | null = null;
let nextFlushedExpirationTime: ExpirationTime = NoWork;
let lowestPriorityPendingInteractiveExpirationTime: ExpirationTime = NoWork;
let hasUnhandledError: boolean = false;
let unhandledError: mixed | null = null;

let isBatchingUpdates: boolean = false;
let isUnbatchingUpdates: boolean = false;

let completedBatches: Array<Batch> | null = null;

let originalStartTimeMs: number = now();
let currentRendererTime: ExpirationTime = msToExpirationTime(
  originalStartTimeMs,
);
let currentSchedulerTime: ExpirationTime = currentRendererTime;

// Use these to prevent an infinite loop of nested updates
const NESTED_UPDATE_LIMIT = 50;
let nestedUpdateCount: number = 0;
let lastCommittedRootDuringThisBatch: FiberRoot | null = null;

function recomputeCurrentRendererTime() {
  // 此处now函数就是上一节
  // now这篇博文系列的前一篇讲过了, 就是performance.now, 具体:
  // https://liuxuan.blog.csdn.net/article/details/90641799
  // originalStartTimeMs = now(); 启动时执行的
  const currentTimeMs = now() - originalStartTimeMs;
  currentRendererTime = msToExpirationTime(currentTimeMs);
}

function scheduleCallbackWithExpirationTime(
  root: FiberRoot,
  expirationTime: ExpirationTime,
) {
  if (callbackExpirationTime !== NoWork) {
    // A callback is already scheduled. Check its expiration time (timeout).
    if (expirationTime < callbackExpirationTime) {
      // Existing callback has sufficient timeout. Exit.
      return;
    } else {
      if (callbackID !== null) {
        // Existing callback has insufficient timeout. Cancel and schedule a
        // new one.
        cancelDeferredCallback(callbackID);
      }
    }
    // The request callback timer is already running. Don't start a new one.
  } else {
    startRequestCallbackTimer();
  }

  callbackExpirationTime = expirationTime;
  const currentMs = now() - originalStartTimeMs;
  const expirationTimeMs = expirationTimeToMs(expirationTime);
  const timeout = expirationTimeMs - currentMs;
  callbackID = scheduleDeferredCallback(performAsyncWork, {timeout});
}

// For every call to renderRoot, one of onFatal, onComplete, onSuspend, and
// onYield is called upon exiting. We use these in lieu of returning a tuple.
// I've also chosen not to inline them into renderRoot because these will
// eventually be lifted into the renderer.
function onFatal(root) {
  root.finishedWork = null;
}

function onComplete(
  root: FiberRoot,
  finishedWork: Fiber, // Root的镜像Fiber Node
  expirationTime: ExpirationTime,
) {
  root.pendingCommitExpirationTime = expirationTime;
  root.finishedWork = finishedWork;
}

function onSuspend(
  root: FiberRoot,
  finishedWork: Fiber,
  suspendedExpirationTime: ExpirationTime,
  rootExpirationTime: ExpirationTime,
  msUntilTimeout: number,
): void {
  root.expirationTime = rootExpirationTime;
  if (msUntilTimeout === 0 && !shouldYieldToRenderer()) {
    // Don't wait an additional tick. Commit the tree immediately.
    root.pendingCommitExpirationTime = suspendedExpirationTime;
    root.finishedWork = finishedWork;
  } else if (msUntilTimeout > 0) {
    // Wait `msUntilTimeout` milliseconds before committing.
    root.timeoutHandle = scheduleTimeout(
      onTimeout.bind(null, root, finishedWork, suspendedExpirationTime),
      msUntilTimeout,
    );
  }
}

function onYield(root) {
  root.finishedWork = null;
}

function onTimeout(root, finishedWork, suspendedExpirationTime) {
  // The root timed out. Commit it.
  root.pendingCommitExpirationTime = suspendedExpirationTime;
  root.finishedWork = finishedWork;
  // Read the current time before entering the commit phase. We can be
  // certain this won't cause tearing related to batching of event updates
  // because we're at the top of a timer event.
  recomputeCurrentRendererTime();
  currentSchedulerTime = currentRendererTime;
  flushRoot(root, suspendedExpirationTime);
}

function onCommit(root, expirationTime) {
  root.expirationTime = expirationTime;
  root.finishedWork = null;
}

function requestCurrentTime() {
  // requestCurrentTime is called by the scheduler to compute an expiration
  // time.
  //
  // Expiration times are computed by adding to the current time (the start
  // time). However, if two updates are scheduled within the same event, we
  // should treat their start times as simultaneous, even if the actual clock
  // time has advanced between the first and second call.
  // 通过添加到当前时间（开始时间）来计算到期时间。 但是，如果在同一事件中安排了两次更新，我们应将它们的开始时间视为同步，即使第一次和第二次呼叫之间的实际时钟时间已提前。

  // In other words, because expiration times determine how updates are batched,
  // 换句话说, 因为过期时间决定了如何批量更新

  // we want all updates of like priority that occur within the same event to
  // receive the same expiration time. Otherwise we get tearing.
  // 我们希望在同一事件中发生的所有类似优先级的更新都会收到相同的到期时间。 否则我们会撕裂。
   
  // We keep track of two separate times: the current "renderer" time and the
  // current "scheduler" time. The renderer time can be updated whenever; it
  // only exists to minimize the calls performance.now.
  // 我们跟踪两个不同的时间：renderer time和scheduler time。 renderer time可以随时使用`performance.now`更新;
  
  // But the scheduler time can only be updated if there's no pending work, or
  // if we know for certain that we're not in the middle of an event.
  // 但是scheduler time只能更新在 没有待处理的工作，或者我们确定我们不在事件的中间时
  if (isRendering) {
    // We're already rendering. Return the most recently read time.
    return currentSchedulerTime;
  }
  // Check if there's pending work.
  findHighestPriorityRoot();
  if (
    nextFlushedExpirationTime === NoWork ||
    nextFlushedExpirationTime === Never
  ) {
    // If there's no pending work, or if the pending work is offscreen, we can
    // read the current time without risk of tearing.
    // 没有待处理的工作，或者待处理的工作是在屏幕外，
    recomputeCurrentRendererTime();
    currentSchedulerTime = currentRendererTime; // 上一个函数计算的值赋值到了currentRendererTime
    return currentSchedulerTime;
  }
  // There's already pending work. We might be in the middle of a browser
  // event. If we were to read the current time, it could cause multiple updates
  // 已经有pending work了。 我们可能正处于浏览器事件的中间。 如果我们要读取当前时间，可能会导致多次更新
  // within the same event to receive different expiration times, leading to
  // tearing. Return the last read time. During the next idle callback, the
  // time will be updated.
  // 防止在事件返回不同时间, 返回上次的时间, 下次空闲回调时时间会更新.
  return currentSchedulerTime;
}

// requestWork is called by the scheduler whenever a root receives an update.
// It's up to the renderer to call renderRoot at some point in the future.
// 只要root收到更新，调度程序就会调用requestWork。由渲染器决定在将来的某个时刻调用renderRoot。
function requestWork(root: FiberRoot, expirationTime: ExpirationTime) {
  addRootToSchedule(root, expirationTime);
  if (isRendering) {
    // Prevent reentrancy. Remaining work will be scheduled at the end of
    // the currently rendering batch.
    return;
  }

  if (isBatchingUpdates) { // 初值为false, 不会进到这个判断里
    // Flush work at the end of the batch.
    if (isUnbatchingUpdates) {
      // ...unless we're inside unbatchedUpdates, in which case we should
      // flush it now.
      nextFlushedRoot = root;
      nextFlushedExpirationTime = Sync;
      performWorkOnRoot(root, Sync, false);
    }
    return;
  }

  // TODO: Get rid of Sync and use current time?
  if (expirationTime === Sync) {
    performSyncWork(); // 这里
  } else {
    scheduleCallbackWithExpirationTime(root, expirationTime); // 这个函数之后系列再看
  }
}

function addRootToSchedule(root: FiberRoot, expirationTime: ExpirationTime) {
  // Add the root to the schedule.
  // Check if this root is already part of the schedule.
  if (root.nextScheduledRoot === null) {
    // This root is not already scheduled. Add it.
    root.expirationTime = expirationTime;
    if (lastScheduledRoot === null) {
      firstScheduledRoot = lastScheduledRoot = root;
      root.nextScheduledRoot = root; // 自身循环, 就一个节点
    } else {
      // 循环链表
      lastScheduledRoot.nextScheduledRoot = root;
      lastScheduledRoot = root;
      lastScheduledRoot.nextScheduledRoot = firstScheduledRoot;
    }
  } else {
    // This root is already scheduled, but its priority may have increased.
    // 如果已经安排过了, 那就判断下过期时间
    const remainingExpirationTime = root.expirationTime;
    if (expirationTime > remainingExpirationTime) {
      // Update the priority.
      root.expirationTime = expirationTime;
    }
  }
}

function findHighestPriorityRoot() {
  let highestPriorityWork = NoWork; // 0
  let highestPriorityRoot = null;
  // lastScheduledRoot初始化为null
  if (lastScheduledRoot !== null) { // lastScheduledRoot为addRootToSchedule设置的FiberRoot
    let previousScheduledRoot = lastScheduledRoot;
    let root = firstScheduledRoot; // 也为FiberRoot
    while (root !== null) {
      const remainingExpirationTime = root.expirationTime;
      if (remainingExpirationTime === NoWork) {
        // This root no longer has work. Remove it from the scheduler.
        // 这个跟节点不再执行, 移除
        // TODO: This check is redudant, but Flow is confused by the branch
        // below where we set lastScheduledRoot to null, even though we break
        // from the loop right after.
        invariant(
          previousScheduledRoot !== null && lastScheduledRoot !== null,
          'Should have a previous and last root. This error is likely ' +
            'caused by a bug in React. Please file an issue.',
        );
        if (root === root.nextScheduledRoot) {
          // This is the only root in the list.
          // 就一个跟节点, 清空
          root.nextScheduledRoot = null;
          firstScheduledRoot = lastScheduledRoot = null;
          break;
        } else if (root === firstScheduledRoot) {
          // This is the first root in the list.
          const next = root.nextScheduledRoot;
          firstScheduledRoot = next;
          lastScheduledRoot.nextScheduledRoot = next;
          root.nextScheduledRoot = null; // 将第一个节点拿出来
        } else if (root === lastScheduledRoot) {
          // This is the last root in the list.
          lastScheduledRoot = previousScheduledRoot;
          lastScheduledRoot.nextScheduledRoot = firstScheduledRoot;
          root.nextScheduledRoot = null; // 最后一个节点拿出来
          break;
        } else {
          previousScheduledRoot.nextScheduledRoot = root.nextScheduledRoot;
          root.nextScheduledRoot = null; // 中间任意节点
        }
        root = previousScheduledRoot.nextScheduledRoot;
      } else {
        if (remainingExpirationTime > highestPriorityWork) {
          // Update the priority, if it's higher
          highestPriorityWork = remainingExpirationTime; // Sync
          highestPriorityRoot = root; // FiberRoot
        }
        if (root === lastScheduledRoot) {
          break; // 退出循环
        }
        if (highestPriorityWork === Sync) {
          // Sync is highest priority by definition so
          // we can stop searching.
          break;
        }
        previousScheduledRoot = root;
        root = root.nextScheduledRoot;
      }
    }
  }

  nextFlushedRoot = highestPriorityRoot; // FiberRoot
  nextFlushedExpirationTime = highestPriorityWork; // Sync
}

// TODO: This wrapper exists because many of the older tests (the ones that use
// flushDeferredPri) rely on the number of times `shouldYield` is called. We
// should get rid of it.
let didYield: boolean = false;
function shouldYieldToRenderer() {
  if (didYield) {
    return true;
  }
  if (shouldYield()) {
    didYield = true;
    return true;
  }
  return false;
}

function performAsyncWork() {
  try {
    if (!shouldYieldToRenderer()) {
      // The callback timed out. That means at least one update has expired.
      // Iterate through the root schedule. If they contain expired work, set
      // the next render expiration time to the current time. This has the effect
      // of flushing all expired work in a single batch, instead of flushing each
      // level one at a time.
      if (firstScheduledRoot !== null) {
        recomputeCurrentRendererTime();
        let root: FiberRoot = firstScheduledRoot;
        do {
          didExpireAtExpirationTime(root, currentRendererTime);
          // The root schedule is circular, so this is never null.
          root = (root.nextScheduledRoot: any);
        } while (root !== firstScheduledRoot);
      }
    }
    performWork(NoWork, true);
  } finally {
    didYield = false;
  }
}

function performSyncWork() {
  performWork(Sync, false);
}

function performWork(
  minExpirationTime: ExpirationTime, // Sync
  isYieldy: boolean, // false
) {
  // Keep working on roots until there's no more work, or until there's a higher
  // priority event.
  // 继续工作直到没有更多的工作，或者直到有更高优先级的事件。

  // 寻找优先级最高的跟节点
  findHighestPriorityRoot();

  if (isYieldy) {
    recomputeCurrentRendererTime();
    currentSchedulerTime = currentRendererTime;

    if (enableUserTimingAPI) {
      const didExpire = nextFlushedExpirationTime > currentRendererTime;
      const timeout = expirationTimeToMs(nextFlushedExpirationTime);
      stopRequestCallbackTimer(didExpire, timeout);
    }

    while (
      nextFlushedRoot !== null &&
      nextFlushedExpirationTime !== NoWork &&
      minExpirationTime <= nextFlushedExpirationTime &&
      !(didYield && currentRendererTime > nextFlushedExpirationTime)
    ) {
      performWorkOnRoot(
        nextFlushedRoot,
        nextFlushedExpirationTime,
        currentRendererTime > nextFlushedExpirationTime,
      );
      findHighestPriorityRoot();
      recomputeCurrentRendererTime();
      currentSchedulerTime = currentRendererTime;
    }
  } else {
    while (
      nextFlushedRoot !== null && // FiberRoot
      nextFlushedExpirationTime !== NoWork && // Sync
      minExpirationTime <= nextFlushedExpirationTime // ok
    ) {
      performWorkOnRoot(nextFlushedRoot, nextFlushedExpirationTime, false);
      findHighestPriorityRoot();
    }
  }

  // We're done flushing work. Either we ran out of time in this callback,
  // or there's no more work left with sufficient priority.

  // If we're inside a callback, set this to false since we just completed it.
  if (isYieldy) {
    callbackExpirationTime = NoWork;
    callbackID = null;
  }
  // If there's work left over, schedule a new callback.
  if (nextFlushedExpirationTime !== NoWork) {
    scheduleCallbackWithExpirationTime(
      ((nextFlushedRoot: any): FiberRoot),
      nextFlushedExpirationTime,
    );
  }

  // Clean-up.
  finishRendering();
}

function flushRoot(root: FiberRoot, expirationTime: ExpirationTime) {
  invariant(
    !isRendering,
    'work.commit(): Cannot commit while already rendering. This likely ' +
      'means you attempted to commit from inside a lifecycle method.',
  );
  // Perform work on root as if the given expiration time is the current time.
  // This has the effect of synchronously flushing all work up to and
  // including the given time.
  nextFlushedRoot = root;
  nextFlushedExpirationTime = expirationTime;
  performWorkOnRoot(root, expirationTime, false);
  // Flush any sync work that was scheduled by lifecycles
  performSyncWork();
}

function finishRendering() {
  nestedUpdateCount = 0;
  lastCommittedRootDuringThisBatch = null;

  if (completedBatches !== null) {
    const batches = completedBatches;
    completedBatches = null;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        batch._onComplete();
      } catch (error) {
        if (!hasUnhandledError) {
          hasUnhandledError = true;
          unhandledError = error;
        }
      }
    }
  }

  if (hasUnhandledError) {
    const error = unhandledError;
    unhandledError = null;
    hasUnhandledError = false;
    throw error;
  }
}

function performWorkOnRoot(
  root: FiberRoot,
  expirationTime: ExpirationTime, // Sync
  isYieldy: boolean, // false
) {
  invariant(
    !isRendering,
    'performWorkOnRoot was called recursively. This error is likely caused ' +
      'by a bug in React. Please file an issue.',
  );

  isRendering = true;

  // Check if this is async work or sync/expired work.
  if (!isYieldy) {
    // Flush work without yielding.
    // TODO: Non-yieldy work does not necessarily imply expired work. A renderer
    // may want to perform some work without yielding, but also without
    // requiring the root to complete (by triggering placeholders).

    let finishedWork = root.finishedWork; // null
    if (finishedWork !== null) {
      // This root is already complete. We can commit it.
      completeRoot(root, finishedWork, expirationTime);
    } else {
      root.finishedWork = null;
      // If this root previously suspended, clear its existing timeout, since
      // we're about to try rendering again.
      const timeoutHandle = root.timeoutHandle; // -1
      // noTimeout值为-1
      if (timeoutHandle !== noTimeout) { // 没有超时
        root.timeoutHandle = noTimeout;
        // $FlowFixMe Complains noTimeout is not a TimeoutID, despite the check above
        cancelTimeout(timeoutHandle);
      }
      renderRoot(root, isYieldy);
      finishedWork = root.finishedWork; // 为root的镜像Fiber root
      if (finishedWork !== null) {
        // We've completed the root. Commit it.
        completeRoot(root, finishedWork, expirationTime);
      }
    }
  } else {
    // Flush async work.
    let finishedWork = root.finishedWork;
    if (finishedWork !== null) {
      // This root is already complete. We can commit it.
      completeRoot(root, finishedWork, expirationTime);
    } else {
      root.finishedWork = null;
      // If this root previously suspended, clear its existing timeout, since
      // we're about to try rendering again.
      const timeoutHandle = root.timeoutHandle;
      if (timeoutHandle !== noTimeout) {
        root.timeoutHandle = noTimeout;
        // $FlowFixMe Complains noTimeout is not a TimeoutID, despite the check above
        cancelTimeout(timeoutHandle);
      }
      renderRoot(root, isYieldy);
      finishedWork = root.finishedWork;
      if (finishedWork !== null) {
        // We've completed the root. Check the if we should yield one more time
        // before committing.
        if (!shouldYieldToRenderer()) {
          // Still time left. Commit the root.
          completeRoot(root, finishedWork, expirationTime);
        } else {
          // There's no time left. Mark this root as complete. We'll come
          // back and commit it later.
          root.finishedWork = finishedWork;
        }
      }
    }
  }

  isRendering = false;
}

function completeRoot(
  root: FiberRoot,
  finishedWork: Fiber, // Root的镜像Fiber Node
  expirationTime: ExpirationTime,
): void {
  // Check if there's a batch that matches this expiration time.
  const firstBatch = root.firstBatch;
  if (firstBatch !== null && firstBatch._expirationTime >= expirationTime) {
    if (completedBatches === null) {
      completedBatches = [firstBatch];
    } else {
      completedBatches.push(firstBatch);
    }
    if (firstBatch._defer) {
      // This root is blocked from committing by a batch. Unschedule it until
      // we receive another update.
      root.finishedWork = finishedWork;
      root.expirationTime = NoWork;
      return;
    }
  }

  // Commit the root.
  root.finishedWork = null;

  // Check if this is a nested update (a sync update scheduled during the
  // commit phase).
  // 检查这是否是嵌套更新
  if (root === lastCommittedRootDuringThisBatch) {
    // If the next root is the same as the previous root, this is a nested
    // update. To prevent an infinite loop, increment the nested update count.
    nestedUpdateCount++;
  } else {
    // Reset whenever we switch roots.
    lastCommittedRootDuringThisBatch = root;
    nestedUpdateCount = 0;
  }
  runWithPriority(ImmediatePriority, () => {
    commitRoot(root, finishedWork);
  });
}

function onUncaughtError(error: mixed) {
  invariant(
    nextFlushedRoot !== null,
    'Should be working on a root. This error is likely caused by a bug in ' +
      'React. Please file an issue.',
  );
  // Unschedule this root so we don't work on it again until there's
  // another update.
  nextFlushedRoot.expirationTime = NoWork;
  if (!hasUnhandledError) {
    hasUnhandledError = true;
    unhandledError = error;
  }
}

// TODO: Batching should be implemented at the renderer level, not inside
// the reconciler.
function batchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingUpdates = true;
  try {
    return fn(a);
  } finally {
    isBatchingUpdates = previousIsBatchingUpdates;
    if (!isBatchingUpdates && !isRendering) {
      performSyncWork();
    }
  }
}

// TODO: Batching should be implemented at the renderer level, not inside
// the reconciler.
function unbatchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  if (isBatchingUpdates && !isUnbatchingUpdates) {
    isUnbatchingUpdates = true;
    try {
      return fn(a);
    } finally {
      isUnbatchingUpdates = false;
    }
  }
  return fn(a);
}

// TODO: Batching should be implemented at the renderer level, not within
// the reconciler.
function flushSync<A, R>(fn: (a: A) => R, a: A): R {
  invariant(
    !isRendering,
    'flushSync was called from inside a lifecycle method. It cannot be ' +
      'called when React is already rendering.',
  );
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingUpdates = true;
  try {
    return syncUpdates(fn, a);
  } finally {
    isBatchingUpdates = previousIsBatchingUpdates;
    performSyncWork();
  }
}

function interactiveUpdates<A, B, R>(fn: (A, B) => R, a: A, b: B): R {
  // If there are any pending interactive updates, synchronously flush them.
  // This needs to happen before we read any handlers, because the effect of
  // the previous event may influence which handlers are called during
  // this event.
  if (
    !isBatchingUpdates &&
    !isRendering &&
    lowestPriorityPendingInteractiveExpirationTime !== NoWork
  ) {
    // Synchronously flush pending interactive updates.
    performWork(lowestPriorityPendingInteractiveExpirationTime, false);
    lowestPriorityPendingInteractiveExpirationTime = NoWork;
  }
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingUpdates = true;
  try {
    return runWithPriority(UserBlockingPriority, () => {
      return fn(a, b);
    });
  } finally {
    isBatchingUpdates = previousIsBatchingUpdates;
    if (!isBatchingUpdates && !isRendering) {
      performSyncWork();
    }
  }
}

function flushInteractiveUpdates() {
  if (
    !isRendering &&
    lowestPriorityPendingInteractiveExpirationTime !== NoWork
  ) {
    // Synchronously flush pending interactive updates.
    performWork(lowestPriorityPendingInteractiveExpirationTime, false);
    lowestPriorityPendingInteractiveExpirationTime = NoWork;
  }
}

function flushControlled(fn: () => mixed): void {
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingUpdates = true;
  try {
    syncUpdates(fn);
  } finally {
    isBatchingUpdates = previousIsBatchingUpdates;
    if (!isBatchingUpdates && !isRendering) {
      performSyncWork();
    }
  }
}

export {
  requestCurrentTime,
  computeExpirationForFiber,
  captureCommitPhaseError,
  onUncaughtError,
  renderDidSuspend,
  renderDidError,
  pingSuspendedRoot,
  retryTimedOutBoundary,
  markLegacyErrorBoundaryAsFailed,
  isAlreadyFailedLegacyErrorBoundary,
  scheduleWork,
  requestWork,
  flushRoot,
  batchedUpdates,
  unbatchedUpdates,
  flushSync,
  flushControlled,
  Scheduler_next as deferredUpdates,
  syncUpdates,
  interactiveUpdates,
  flushInteractiveUpdates,
  computeUniqueAsyncExpiration,
  flushPassiveEffects,
};

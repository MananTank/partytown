import { getConstructorName, isValidMemberName, startsWith } from '../utils';
import { getInstance, getAndSetInstanceId } from './main-instances';
import { mainRefs } from './main-constants';
import {
  PartytownWebWorker,
  PlatformInstanceId,
  SerializedCSSRule,
  SerializedInstance,
  SerializedObject,
  SerializedRefTransferData,
  SerializedTransfer,
  SerializedType,
  WorkerMessageType,
} from '../types';

export const serializeForWorker = (
  $winId$: number,
  value: any,
  added?: Set<any>,
  type?: string,
  cstrName?: string
): SerializedTransfer | undefined => {
  if (value !== undefined && (type = typeof value)) {
    if (type === 'string' || type === 'number' || type === 'boolean' || value == null) {
      return [SerializedType.Primitive, value];
    } else if (type === 'function') {
      return [SerializedType.Function];
    } else if ((added = added || new Set()) && Array.isArray(value)) {
      if (added.has(value)) {
        return [SerializedType.Array, []];
      } else {
        return (
          added.add(value) && [
            SerializedType.Array,
            value.map((v) => serializeForWorker($winId$, v, added)),
          ]
        );
      }
    } else if (type === 'object') {
      if ((cstrName = getConstructorName(value)) === '') {
        // error reading this object, probably "DOMException: Blocked from accessing a cross-origin frame."
        return [SerializedType.Object, {}];
      } else if (cstrName === 'Window') {
        return [
          SerializedType.Instance,
          {
            $winId$,
            $instanceId$: PlatformInstanceId.window,
          },
        ];
      } else if (cstrName === 'HTMLCollection' || cstrName === 'NodeList') {
        return [
          SerializedType.NodeList,
          Array.from(value).map((v) => serializeForWorker($winId$, v, added)![1]) as any,
        ];
      } else if (cstrName.endsWith('Event')) {
        return [SerializedType.Event, serializeObjectForWorker($winId$, value, added)];
      } else if (cstrName === 'CSSRuleList') {
        return [SerializedType.CSSRuleList, Array.from(value).map(serializeCssRuleForWorker)];
      } else if (startsWith(cstrName, 'CSS') && cstrName.endsWith('Rule')) {
        return [SerializedType.CSSRule, serializeCssRuleForWorker(value)];
      } else if (cstrName === 'CSSStyleDeclaration') {
        return [
          SerializedType.CSSStyleDeclaration,
          serializeObjectForWorker($winId$, value, added),
        ];
      } else if (cstrName === 'Attr') {
        return [SerializedType.Attr, [(value as Attr).name, (value as Attr).value]];
      } else if (value.nodeType) {
        return [
          SerializedType.Instance,
          {
            $winId$,
            $instanceId$: getAndSetInstanceId(value),
            $nodeName$: value.nodeName,
          },
        ];
      } else {
        return [SerializedType.Object, serializeObjectForWorker($winId$, value, added, true, true)];
      }
    } else {
      return;
    }
  } else {
    return value;
  }
};

const serializeObjectForWorker = (
  winId: number,
  obj: any,
  added: Set<any>,
  includeFunctions?: boolean,
  includeEmptyStrings?: boolean,
  serializedObj?: SerializedObject,
  propName?: string,
  propValue?: any
) => {
  serializedObj = {};
  if (!added.has(obj)) {
    added.add(obj);
    for (propName in obj) {
      if (isValidMemberName(propName)) {
        propValue = obj[propName];
        if (includeFunctions || typeof propValue !== 'function') {
          if (includeEmptyStrings || propValue !== '') {
            serializedObj[propName] = serializeForWorker(winId, propValue, added);
          }
        }
      }
    }
  }
  return serializedObj;
};

const serializeCssRuleForWorker = (cssRule: any) => {
  let obj: SerializedCSSRule = {};
  let key: string;
  for (key in cssRule) {
    if (validCssRuleProps.includes(key)) {
      obj[key] = cssRule[key];
    }
  }
  return obj;
};

export const deserializeFromWorker = (
  worker: PartytownWebWorker,
  serializedTransfer: SerializedTransfer | undefined,
  serializedType?: SerializedType,
  serializedValue?: any
): any => {
  if (serializedTransfer) {
    serializedType = serializedTransfer[0];
    serializedValue = serializedTransfer[1] as any;

    if (serializedType === SerializedType.Primitive) {
      return serializedValue;
    } else if (serializedType === SerializedType.Ref) {
      return deserializeRefFromWorker(worker, serializedValue);
    } else if (serializedType === SerializedType.Array) {
      return (serializedValue as SerializedTransfer[]).map((v) => deserializeFromWorker(worker, v));
    } else if (serializedType === SerializedType.Instance) {
      return getInstance(
        (serializedValue as SerializedInstance).$winId$,
        (serializedValue as SerializedInstance).$instanceId$!
      );
    } else if (serializedType === SerializedType.Event) {
      return constructEvent(deserializeObjectFromWorker(worker, serializedValue));
    } else if (serializedType === SerializedType.Object) {
      return deserializeObjectFromWorker(worker, serializedValue);
    } else if (serializedType === SerializedType.ArrayBuffer) {
      return serializedValue;
    } else if (serializedType === SerializedType.ArrayBufferView) {
      return new (window as any)[serializedTransfer[2]!](serializedValue);
    } else {
      return;
    }
  } else {
    // improve minification
    return;
  }
};

const deserializeRefFromWorker = (
  worker: PartytownWebWorker,
  { $winId$, $instanceId$, $refId$ }: SerializedRefTransferData,
  ref?: any
) => {
  ref = mainRefs.get($refId$);

  if (!ref) {
    ref = function (this: any, ...args: any[]) {
      worker.postMessage([
        WorkerMessageType.RefHandlerCallback,
        {
          $winId$,
          $instanceId$,
          $refId$,
          $thisArg$: serializeForWorker($winId$, this),
          $args$: serializeForWorker($winId$, args),
        },
      ]);
    };
    mainRefs.set($refId$, ref);
  }

  return ref;
};

const constructEvent = (eventProps: any) =>
  new ('detail' in eventProps ? CustomEvent : Event)(eventProps.type, eventProps);

const deserializeObjectFromWorker = (
  worker: PartytownWebWorker,
  serializedValue: any,
  obj?: any,
  key?: string
) => {
  obj = {};
  for (key in serializedValue) {
    obj[key] = deserializeFromWorker(worker, serializedValue[key]);
  }
  return obj;
};

const validCssRuleProps =
  'cssText,selectorText,href,media,namespaceURI,prefix,name,conditionText'.split(',');

// 仅用于本机无法安装 @types/react 时的本地类型检查，不随项目发布。
// 正式开发请使用 npm install 安装的 @types/react。

declare namespace React {
  type ReactNode = ReactElement | string | number | bigint | boolean | null | undefined | Iterable<ReactNode>;
  interface ReactElement {
    type: unknown;
    props: unknown;
    key: string | null;
  }
  type Key = string | number;
  type SetStateAction<S> = S | ((prev: S) => S);
  type Dispatch<A> = (value: A) => void;
  interface RefObject<T> {
    current: T;
  }
  type Ref<T> = RefObject<T | null> | ((instance: T | null) => void) | null;
  type CSSProperties = { [key: string]: string | number | undefined };
  type FC<P = {}> = (props: P) => ReactNode;
  type PropsWithChildren<P = unknown> = P & { children?: ReactNode };
  interface Context<T> {
    Provider: (props: { value: T; children?: ReactNode }) => ReactElement;
    _value?: T;
  }

  interface SyntheticEvent<T = Element, E = Event> {
    currentTarget: T;
    target: EventTarget & T;
    nativeEvent: E;
    preventDefault(): void;
    stopPropagation(): void;
    defaultPrevented: boolean;
    type: string;
  }
  interface ChangeEvent<T = Element> extends SyntheticEvent<T> {
    target: EventTarget & T;
  }
  interface FormEvent<T = Element> extends SyntheticEvent<T> {}
  interface MouseEvent<T = Element> extends SyntheticEvent<T, globalThis.MouseEvent> {
    clientX: number;
    clientY: number;
    button: number;
  }
  interface PointerEvent<T = Element> extends MouseEvent<T> {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;
  }
  interface WheelEvent<T = Element> extends MouseEvent<T> {
    deltaX: number;
    deltaY: number;
  }
  interface KeyboardEvent<T = Element> extends SyntheticEvent<T, globalThis.KeyboardEvent> {
    key: string;
  }
  interface UIEvent<T = Element> extends SyntheticEvent<T> {}
}

declare module 'react' {
  export = React;
  export as namespace React;
}

declare namespace React {
  function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  function useRef<T>(initial: T): RefObject<T>;
  function useRef<T>(initial: T | null): RefObject<T | null>;
  function useContext<T>(ctx: Context<T>): T;
  function createContext<T>(defaultValue: T): Context<T>;
  function useId(): string;
  function useReducer<S, A>(reducer: (s: S, a: A) => S, initial: S): [S, Dispatch<A>];
  class Component<P = {}, S = {}> {
    constructor(props: P);
    readonly props: Readonly<P>;
    state: Readonly<S>;
    setState(s: Partial<S> | ((prev: S) => Partial<S>)): void;
    render(): ReactNode;
  }
  const Fragment: (props: { children?: ReactNode; key?: Key }) => ReactElement;
  const StrictMode: (props: { children?: ReactNode }) => ReactElement;
}

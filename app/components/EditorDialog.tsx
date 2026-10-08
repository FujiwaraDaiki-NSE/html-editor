"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

type Request = { message: string; initialValue: string | null };

function EditorDialog({ request, finish }: { request: Request; finish: (value: string | null) => void }) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(request.initialValue === null ? "" : request.initialValue);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={ref} className="editor-dialog skill-dialog" aria-labelledby={id} onCancel={(event) => { event.preventDefault(); finish(null); }}>
    <form onSubmit={(event) => { event.preventDefault(); finish(value); }}>
      <header><strong id={id}>{request.message}</strong></header>
      {request.initialValue !== null && <div className="skill-dialog-body"><label className="skill-dialog-field"><span>{request.message}</span><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} /></label></div>}
      <footer className="skill-dialog-actions"><button type="button" autoFocus={request.initialValue === null} onClick={() => finish(null)}>キャンセル</button><button type="submit" className="primary-button">確定</button></footer>
    </form>
  </dialog>;
}

/** The same accessible dialog is used by the human and the agent UI tools. */
export function useEditorDialog() {
  const [request, setRequest] = useState<Request | null>(null);
  const resolve = useRef<((value: string | null) => void) | null>(null);
  const finish = useCallback((value: string | null) => {
    const pending = resolve.current;
    resolve.current = null;
    setRequest(null);
    pending?.(value);
  }, []);
  useEffect(() => () => { resolve.current?.(null); resolve.current = null; }, []);
  const open = useCallback((message: string, initialValue: string | null) => {
    if (resolve.current) return Promise.reject(new Error("別の確認操作が進行中です。"));
    return new Promise<string | null>((complete) => {
      resolve.current = complete;
      setRequest({ message, initialValue });
    });
  }, []);
  return {
    prompt: useCallback((message: string, initialValue: string) => open(message, initialValue), [open]),
    confirm: useCallback(async (message: string) => (await open(message, null)) !== null, [open]),
    dialog: request === null ? null : <EditorDialog request={request} finish={finish} />,
  };
}

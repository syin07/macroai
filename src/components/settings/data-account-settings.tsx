"use client";
import { useEffect, useRef, useState } from "react";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { deleteAccount, exportData } from "@/lib/api";
import { authClient, authError } from "@/lib/api/auth";
import { endAccountSession } from "@/lib/api/account-session";
import { useMe } from "@/hooks/use-api";
import type { ExportFormat, ExportScope } from "@/types/api";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  action,
  control,
  QueryNotice,
  SettingsSection,
} from "./settings-shared";

export function DataSettings() {
  const urls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const pending = urls.current;
    return () => {
      for (const [url, timer] of pending) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      pending.clear();
    };
  }, []);
  const download = useMutation({
    mutationFn: async ({
      format,
      scope,
    }: {
      format: ExportFormat;
      scope: ExportScope;
    }) => {
      const blob = await exportData(format, scope);
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `macroai-${scope}-${new Date().toISOString().slice(0, 10)}.${format}`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        const timer = setTimeout(() => {
          URL.revokeObjectURL(url);
          urls.current.delete(url);
        }, 1000);
        urls.current.set(url, timer);
      }
    },
    onSuccess: () =>
      setNotice("Download requested. Check your browser’s downloads."),
    onMutate: () => setNotice(""),
  });
  return (
    <SettingsSection
      title="Data"
      description="Nutrition exports include your saved meals. The full account JSON also includes chats, memories, goals, and preferences."
    >
      <div className="flex flex-col items-start gap-2">
        {[
          ["Nutrition CSV", "csv", "nutrition"],
          ["Nutrition JSON", "json", "nutrition"],
          ["Full account JSON", "json", "account"],
        ].map(([label, format, scope]) => (
          <button
            key={label}
            className={action}
            disabled={download.isPending}
            onClick={() => {
              void download
                .mutateAsync({
                  format: format as ExportFormat,
                  scope: scope as ExportScope,
                })
                .catch(() => {});
            }}
          >
            {download.isPending &&
            download.variables?.format === format &&
            download.variables?.scope === scope
              ? "Preparing download…"
              : `Export ${label}`}
          </button>
        ))}
      </div>
      {download.isError && (
        <p role="alert" className="mt-3 text-sm">
          {download.error.message}{" "}
          <button
            className="chat-text-button"
            onClick={() => {
              if (download.variables)
                void download.mutateAsync(download.variables).catch(() => {});
            }}
          >
            Retry export
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm">
          {notice}
        </p>
      )}
    </SettingsSection>
  );
}

export function AccountSettings() {
  const me = useMe();
  const client = useQueryClient();
  const mutating = useIsMutating();
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState("");
  const inFlight = useRef(false);
  const signOut = useMutation({
    mutationFn: async () => {
      if (inFlight.current)
        throw new Error("An account action is already running.");
      inFlight.current = true;
      try {
        await authClient.signOut();
      } catch (error) {
        inFlight.current = false;
        throw authError(error);
      }
      await endAccountSession(client);
    },
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (typed !== "DELETE") throw new Error("Type DELETE to confirm.");
      if (inFlight.current)
        throw new Error("An account action is already running.");
      inFlight.current = true;
      try {
        await deleteAccount({ redirectOnAuthError: false });
      } catch (error) {
        inFlight.current = false;
        throw error;
      }
      await endAccountSession(client);
    },
  });
  const busy = signOut.isPending || remove.isPending;
  return (
    <SettingsSection title="Account">
      {me.data ? (
        <p className="mb-4 break-all text-sm text-muted-foreground">
          Signed in as {me.data.email}
        </p>
      ) : (
        <QueryNotice
          pending={me.isPending}
          error={me.isError}
          retry={() => void me.refetch()}
        />
      )}
      <div className="flex flex-wrap gap-3">
        <button
          className={action}
          disabled={mutating > 0}
          onClick={() => {
            void signOut.mutateAsync().catch(() => {});
          }}
        >
          {signOut.isPending
            ? "Signing out…"
            : signOut.isError
              ? "Retry sign out"
              : "Sign out"}
        </button>
        <button
          className={action}
          disabled={mutating > 0 || !me.data}
          onClick={() => {
            setConfirm(true);
            setTyped("");
            remove.reset();
          }}
        >
          Delete account
        </button>
      </div>
      {signOut.isError && (
        <p role="alert" className="mt-3 text-sm">
          {signOut.error.message}
        </p>
      )}
      <Dialog
        open={confirm}
        onOpenChange={(open) => {
          if (!busy) setConfirm(open);
        }}
      >
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto"
          showCloseButton={!busy}
        >
          <DialogTitle>Delete your account?</DialogTitle>
          <DialogDescription>
            This permanently deletes your account, saved meals, chats, goals,
            preferences, and memories. This cannot be undone. Export your data
            first if you want a copy.
          </DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (typed === "DELETE" && !busy && mutating === 0)
                void remove.mutateAsync().catch(() => {});
            }}
          >
            <label className="block text-sm">
              Type DELETE to confirm
              <input
                aria-label="Type DELETE to confirm"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                disabled={busy}
                onChange={(event) => {
                  setTyped(event.target.value);
                  remove.reset();
                }}
                className={`${control} mt-2`}
              />
            </label>
            {remove.isError && (
              <p role="alert" className="mt-3 text-sm">
                {remove.error.message}
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={busy}
                className={action}
                onClick={() => setConfirm(false)}
              >
                Keep account
              </button>
              <button
                type="submit"
                disabled={typed !== "DELETE" || mutating > 0}
                className={`${action} border-destructive text-destructive`}
              >
                {remove.isPending
                  ? "Deleting account…"
                  : remove.isError
                    ? "Retry account deletion"
                    : "Permanently delete account"}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

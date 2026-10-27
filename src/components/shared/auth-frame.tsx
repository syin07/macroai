import { Brand } from "./brand";

export function AuthFrame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="auth-frame flex min-h-dvh flex-col items-center px-6 py-10 sm:justify-center">
      <div className="w-full max-w-sm">
        <Brand />
        <div className="mt-14 rounded-2xl border border-[var(--app-line)] bg-[var(--app-surface)] p-7 sm:p-8">
          <h1 className="text-2xl font-semibold tracking-[-0.04em]">{title}</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {description}
          </p>
          <div className="mt-8 flex flex-wrap gap-x-5 gap-y-3 text-sm">
            {children}
          </div>
        </div>
      </div>
    </main>
  );
}

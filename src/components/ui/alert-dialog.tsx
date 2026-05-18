import * as React from 'react';

type OpenChange = (open: boolean) => void;

interface AlertDialogContextValue {
  open: boolean;
  onOpenChange: OpenChange;
}

const AlertDialogContext = React.createContext<AlertDialogContextValue | null>(null);

function useAlertDialogContext(component: string): AlertDialogContextValue {
  const ctx = React.useContext(AlertDialogContext);
  if (!ctx) {
    throw new Error(`${component} moet binnen <AlertDialog> gebruikt worden.`);
  }
  return ctx;
}

interface AlertDialogProps {
  open: boolean;
  onOpenChange: OpenChange;
  children: React.ReactNode;
}

export function AlertDialog({ open, onOpenChange, children }: AlertDialogProps) {
  return (
    <AlertDialogContext.Provider value={{ open, onOpenChange }}>
      {children}
    </AlertDialogContext.Provider>
  );
}

interface AlertDialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function AlertDialogContent({
  className = '',
  children,
  ...props
}: AlertDialogContentProps) {
  const { open, onOpenChange } = useAlertDialogContext('AlertDialogContent');

  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onOpenChange(false);
    }
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        className={`bg-white rounded-lg shadow-xl max-w-lg w-full p-6 space-y-4 ${className}`}
        onMouseDown={(e) => e.stopPropagation()}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}

export function AlertDialogHeader({
  className = '',
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`flex flex-col space-y-2 ${className}`} {...props} />;
}

export function AlertDialogFooter({
  className = '',
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 gap-2 sm:gap-0 ${className}`}
      {...props}
    />
  );
}

export function AlertDialogTitle({
  className = '',
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={`text-lg font-semibold text-gray-900 ${className}`} {...props} />;
}

export function AlertDialogDescription({
  className = '',
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={`text-sm text-gray-600 ${className}`} {...props} />;
}

interface AlertDialogActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export function AlertDialogAction({
  className = '',
  type = 'button',
  ...props
}: AlertDialogActionProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      {...props}
    />
  );
}

interface AlertDialogCancelProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export function AlertDialogCancel({
  className = '',
  type = 'button',
  onClick,
  ...props
}: AlertDialogCancelProps) {
  const { onOpenChange } = useAlertDialogContext('AlertDialogCancel');
  return (
    <button
      type={type}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onOpenChange(false);
      }}
      className={`inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-100 rounded-md transition-colors disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}

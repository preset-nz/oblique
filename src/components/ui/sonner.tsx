import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { Icons } from "@preset.nz/ux-kit"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <Icons.CheckCircleIcon className="size-4" />
        ),
        info: (
          <Icons.InfoIcon className="size-4" />
        ),
        warning: (
          <Icons.WarningIcon className="size-4" />
        ),
        error: (
          <Icons.XCircleIcon className="size-4" />
        ),
        loading: (
          <Icons.SpinnerIcon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }

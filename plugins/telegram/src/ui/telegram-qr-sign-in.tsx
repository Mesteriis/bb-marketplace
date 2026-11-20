import { Send } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useId, type ReactNode } from "react";
import { useTelegramLocale } from "./i18n/index.tsx";

export function TelegramQrSignIn({ link, accounts, children }: {
  link: string;
  accounts: ReactNode;
  children?: ReactNode;
}) {
  const { locale, t: tr } = useTelegramLocale();
  const heading = useId();
  return <div lang={locale} data-bb-ru-skip className="mtg mtg-login">
    <section className="mtg-qr-sign-in" aria-labelledby={heading}>
      <header>
        <span className="mtg-qr-brand"><Send size={22} strokeWidth={1.7} aria-hidden="true" />Telegram</span>
        {accounts}
      </header>
      <div className="mtg-qr-body">
        <div className="mtg-qr-frame">
          <span aria-hidden="true" className="mtg-qr-corners"><i /><i /><i /><i /></span>
          <QRCodeSVG value={link} size={248} level="M" marginSize={4}
            fgColor="#000000" bgColor="#ffffff" role="img" aria-label={tr("Telegram sign-in QR code")} />
        </div>
        <div className="mtg-qr-instructions">
          <h1 id={heading}>{tr("Scan the QR code")}</h1>
          <p>{tr("On your phone, open Telegram → Settings → Devices → Link Desktop Device, then scan this code.")}</p>
        </div>
        <p className="mtg-qr-status" role="status">{tr("Waiting for QR scan…")}</p>
      </div>
      {children && <footer>{children}</footer>}
    </section>
  </div>;
}

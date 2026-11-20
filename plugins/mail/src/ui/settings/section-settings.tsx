// The rows of plain settings each section shows, grouped as the page's map
// says. They change the plugin's own settings from the page; the three agent
// switches are shown and never changed here (page-settings.ts).
import { SUPPORTED_LANGUAGES } from "../../core/translate.ts";
import { tx } from "../i18n/index.ts";
import { SettingsGroup } from "./primitives.tsx";
import { LongTextSetting, NumberSetting, ReadOnlySetting, SelectSetting, SwitchSetting, TextSetting, type PageSettingsPort } from "./setting-controls.tsx";

type Rows = { port: PageSettingsPort };

/** Where the agent switches are changed. */
const BB_SETTINGS_PLACE = "BB Settings → Plugins → Makosh Mail";

export function CategoriesSetting({ port }: Rows) {
  return (
    <SwitchSetting
      port={port}
      name="mailCategories"
      label={tx("Sort mail into categories")}
      hint={tx("Bills, Notifications, Personal and Newsletters live only in Makosh Mail; nothing is written to the mail server.")}
    />
  );
}

export function TodaySettings({ port }: Rows) {
  return (
    <>
      <SwitchSetting port={port} name="morningDigest" label={tx("Daily Today digest")} hint={tx("Off: the Today view still works when you open it.")} />
      <TextSetting port={port} name="digestTime" type="time" label={tx("Digest time")} hint={tx("This computer's time.")} />
    </>
  );
}

export function ReminderSetting({ port }: Rows) {
  return (
    <NumberSetting
      port={port}
      name="replyReminderDays"
      label={tx("Remind about a reply after")}
      hint={tx("A reminder turns due when no message answering yours (by In-Reply-To or References) arrives in time.")}
      unit={tx("days")}
    />
  );
}

export function TranslateLanguageSetting({ port }: Rows) {
  return (
    <SelectSetting
      port={port}
      name="translateLanguage"
      label={tx("Translate into")}
      options={SUPPORTED_LANGUAGES.map((language) => ({ value: language.tag, label: language.native }))}
    />
  );
}

/** The three switches that widen what agents may do: their state, and where they are changed. */
export function AgentSwitches({ port }: Rows) {
  const values = port.values;
  return (
    <SettingsGroup title={tx("What agents may do")}>
      <div className="flex flex-col">
        <ReadOnlySetting label={tx("Search and read mail in every thread")} on={values === null ? null : values.agentTools} />
        <ReadOnlySetting label={tx("Propose mail for you to send")} on={values === null ? null : values.agentPropose} />
        <ReadOnlySetting label={tx("Propose inbox actions for you to approve")} on={values === null ? null : values.agentTriage} />
      </div>
      <p className="text-xs text-muted-foreground">
        {tx("These three are changed only in {place}, so that nothing but your own click can widen what agents may do with mail.", { place: BB_SETTINGS_PLACE })}
      </p>
    </SettingsGroup>
  );
}

/** Typing speed: the composer's aids (in the Templates section). */
export function TypingSettings({ port }: Rows) {
  return (
    <SettingsGroup title={tx("Typing")}>
      <div className="flex flex-col">
        <SwitchSetting
          port={port}
          name="autocorrect"
          label={tx("Fix common typing slips as I write")}
          hint={tx("Backspace right after a fix puts back what you typed.")}
        />
        <TextSetting
          port={port}
          name="autocorrectPairs"
          wide
          label={tx("My own replacements")}
          hint={tx("from => to, separated by semicolons.")}
          placeholder="brb => be right back; omw => on my way"
        />
        <SwitchSetting
          port={port}
          name="autocomplete"
          label={tx("Offer the rest of phrases I often write")}
          hint={tx("From your own sent mail and templates, on this computer. Tab accepts.")}
        />
        <SwitchSetting
          port={port}
          name="readStatuses"
          label={tx("Show when mail I send is opened")}
          hint={tx("A tiny image from your own endpoint in mail you send. An open is a hint, not a proof: some mail services fetch images by themselves, many programs never do. Never in signed or encrypted mail.")}
        />
        <TextSetting
          port={port}
          name="readStatusExceptions"
          wide
          label={tx("Never show opens for")}
          hint={tx("Addresses and domains, separated by commas: mail to any of them goes without the image.")}
          placeholder="boss@example.com, example.org"
        />
      </div>
    </SettingsGroup>
  );
}

/** AI writes mail: the voice, auto drafts, and the owner's instructions and facts (in the AI features section). */
export function WritingSettings({ port }: Rows) {
  return (
    <SettingsGroup title={tx("Writing")}>
      <div className="flex flex-col">
        <SwitchSetting
          port={port}
          name="aiVoice"
          label={tx("Write in my voice")}
          hint={tx("When AI writes a message, it is shown a few pieces of your own sent mail to match your tone.")}
        />
        <SwitchSetting
          port={port}
          name="aiAutoDrafts"
          label={tx("Draft replies to new mail")}
          hint={tx("Uses your AI provider for every new message from people you write to; at most 50 a day. Nothing is sent without you.")}
        />
        <LongTextSetting
          port={port}
          name="aiInstructions"
          maxLength={2_000}
          label={tx("My instructions for AI writing")}
          hint={tx("For example: sign as Alex; answer in the language of the message.")}
        />
        <LongTextSetting
          port={port}
          name="aiKnowledge"
          maxLength={6_000}
          label={tx("Facts AI may use")}
          hint={tx("Prices, addresses, working hours, links. AI adds no other facts or links.")}
        />
      </div>
    </SettingsGroup>
  );
}

export function NotificationSettings({ port }: Rows) {
  return (
    <SettingsGroup title={tx("New mail notifications")}>
      <div className="flex flex-col">
        <SwitchSetting port={port} name="notifyNewMail" label={tx("Notify about new mail")} hint={tx("From people you write to.")} />
        <SwitchSetting port={port} name="notifyImportantOnly" label={tx("Only from important senders")} />
        <TextSetting
          port={port}
          name="importantSenders"
          wide
          label={tx("Important senders")}
          hint={tx("Addresses or domains, separated by commas.")}
          placeholder="boss@example.org, example.com"
        />
        <TextSetting port={port} name="quietHours" label={tx("Quiet hours")} hint={tx("This computer's time; empty for none.")} placeholder="22:00-08:00" />
      </div>
    </SettingsGroup>
  );
}

export function ReadingSettings({ port }: Rows) {
  return (
    <>
      <SettingsGroup title={tx("Reading")}>
        <div className="flex flex-col">
          <SelectSetting
            port={port}
            name="mailView"
            label={tx("Show mail as")}
            options={[
              { value: "original", label: tx("Original") },
              { value: "plain", label: tx("Plain text") },
            ]}
          />
          <SelectSetting
            port={port}
            name="darkMail"
            label={tx("Mail in dark mode")}
            options={[
              { value: "adapt", label: tx("Adapt colors") },
              { value: "original", label: tx("Original colors") },
            ]}
          />
          <SwitchSetting port={port} name="hideQuotes" label={tx("Hide quoted text in replies")} />
          <SwitchSetting port={port} name="cleanLinks" label={tx("Remove tracking from links I open")} />
        </div>
      </SettingsGroup>
      <SettingsGroup title={tx("Layout")}>
        <div className="flex flex-col">
          <SelectSetting
            port={port}
            name="listDensity"
            label={tx("List rows")}
            options={[
              { value: "comfortable", label: tx("Comfortable") },
              { value: "compact", label: tx("Compact") },
            ]}
          />
          <SelectSetting
            port={port}
            name="readingPane"
            label={tx("Reading pane")}
            options={[
              { value: "right", label: tx("On the right") },
              { value: "bottom", label: tx("Below the list") },
            ]}
          />
          <SelectSetting
            port={port}
            name="language"
            label={tx("Language of Mail's pages")}
            options={[
              { value: "auto", label: tx("As in BB") },
              { value: "ru", label: "Русский" },
              { value: "en", label: "English" },
            ]}
          />
        </div>
      </SettingsGroup>
    </>
  );
}

export function SearchSettings({ port }: Rows) {
  return (
    <div className="flex flex-col">
      <NumberSetting port={port} name="historyStepDays" label={tx("\"Load more days\" loads")} hint={tx("From 7 to 365 days at a time.")} unit={tx("days")} />
      <NumberSetting port={port} name="serverSearchKeepDays" label={tx("Keep unopened server search results")} hint={tx("From 1 to 90 days.")} unit={tx("days")} />
      <SwitchSetting
        port={port}
        name="indexAttachmentText"
        label={tx("Search inside attachments")}
        hint={tx("Text and PDF attachments are read on this computer, and only your own search uses them.")}
      />
    </div>
  );
}

export function IntegrationSettings({ port }: Rows) {
  return (
    <div className="flex flex-col">
      <TextSetting port={port} name="attachmentFolder" label={tx("Folder for attachments saved into a project")} placeholder="mail-attachments" />
      <TextSetting port={port} name="patchFolder" label={tx("Folder for patches saved into a project")} placeholder="mail-patches" />
      <SelectSetting
        port={port}
        name="taskTarget"
        label={tx("Make a task in")}
        options={[
          { value: "auto", label: tx("Taskboard when it answers, else Mail's own Tasks") },
          { value: "taskboard", label: tx("Taskboard") },
          { value: "local", label: tx("Mail's own Tasks") },
        ]}
      />
      <SwitchSetting
        port={port}
        name="devNotifications"
        label={tx("Recognise dev notifications")}
        hint={tx("GitHub, GitLab, CI and monitoring mail is recognised on this computer and gets the Dev view.")}
      />
    </div>
  );
}

export function RulesSwitch({ port }: Rows) {
  return (
    <SwitchSetting
      port={port}
      name="mailRules"
      label={tx("Run my rules on new Inbox mail")}
      hint={tx("Rules prepare agent threads from new Inbox mail for you to review, or start them if you chose that for a rule. Threads a rule starts have no mail tools.")}
    />
  );
}

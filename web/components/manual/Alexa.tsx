import Link from 'next/link';
import ManualPage from './ManualPage';
import CodeBlock from '@/components/CodeBlock';

export default function Alexa() {
  return (
    <ManualPage
      eyebrow="MANUAL · 08"
      title="Connect your Alexa skill."
      intro="SUB/WAVE can host the webhook for an Alexa Custom Skill that you own. Alexa calls your station over HTTPS, receives an AudioPlayer directive, and fetches the selected stream directly. This is a private, station-owned connection — it is not Alexa's public radio catalogue and it does not use TuneIn. Listener authentication can remain enabled through temporary Alexa-only signed stream URLs."
      current="/manual/alexa"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">HOW IT WORKS</p>
        <h2>One skill, one station.</h2>
        <p>
          The station name is dynamic. If you rename the station in <strong>Station settings</strong>,
          SUB/WAVE uses the new name in its confirmation and Alexa playback response. The
          <strong> invocation name</strong> is different: it belongs to the Alexa skill and stays
          fixed until you change it in the Alexa Developer Console.
        </p>
        <CodeBlock>{`Alexa, open subwave controller
        │
        ▼
Alexa sends a signed POST to https://your-station.example/api/alexa
        │
        ▼
SUB/WAVE returns AudioPlayer.Play with the selected stream mount
  (direct URL, or a temporary signed URL when listener auth is on)
        │
        ▼
Alexa fetches the stream directly from the station
        │
        └─ protected stations: Icecast validates the signed token at connect time`}</CodeBlock>
        <p>
          The webhook does not send audio bytes through the Alexa request. It returns the
          HTTPS stream URL, and the Echo device retrieves that URL itself. With listener
          authentication enabled, the URL contains a short-lived HMAC-signed bearer token;
          it does not contain the station password. The token is checked by the existing
          Icecast listener-auth callback and is bound to the selected mount.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PROTECTED STREAMS</p>
        <h2>Alexa gets temporary access, not your password.</h2>
        <p>
          When <strong>listener authentication</strong> is off, the skill returns the selected
          stream mount directly. When it is on, SUB/WAVE signs a token with the station
          password and appends it to the stream URL as Alexa starts or resumes playback. The
          password never appears in the Alexa response or URL.
        </p>
        <ul className="bs-list">
          <li>The token is bound to one mount, such as <code className="bs-code-inline">/stream.mp3</code>, and is checked by Icecast's existing URL-auth callback.</li>
          <li>Set the lifetime in <strong>Connect → Alexa → Alexa signed-stream lifetime</strong>. The available range is 1 hour to 7 days.</li>
          <li>A new token is generated for every play or resume request. Expiry is checked when Alexa connects; an already-playing stream is not cut off when the clock reaches expiry.</li>
          <li>Because the token is a bearer credential, anyone who obtains the complete temporary URL could use it until it expires. Keep endpoint and proxy logs private and choose the shortest practical lifetime.</li>
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">BEFORE YOU START</p>
        <h2>Make the station reachable.</h2>
        <ul className="bs-list">
          <li>
            Set <code className="bs-code-inline">SITE_URL</code> to the public HTTPS origin,
            for example <code className="bs-code-inline">https://radio.example.com</code>.
            Do not put <code className="bs-code-inline">/api/alexa</code> in{' '}
            <code className="bs-code-inline">SITE_URL</code>; SUB/WAVE adds that path for the
            webhook and adds the selected stream mount for playback.
          </li>
          <li>
            The origin must be reachable from the internet on HTTPS port 443 and present a
            certificate trusted by Amazon. A Cloudflare Tunnel or another reverse proxy is
            fine when its public hostname has a valid public certificate and does not show an
            access page to Alexa.
          </li>
          <li>
            Listener authentication may stay enabled. SUB/WAVE creates a new signed Alexa
            stream URL for each play or resume request; the normal listener URL remains
            password-protected. The signed URL is a bearer credential, so do not share it.
          </li>
          <li>
            Enable the selected stream mount in SUB/WAVE before choosing it in the Alexa
            panel. MP3 is the safest choice for Echo playback; AAC is another conventional
            Alexa option. Opus and FLAC are exposed by SUB/WAVE for capable players, but Ogg
            is not listed in Alexa's standard long-form AudioPlayer formats, so verify those
            formats on the exact device before relying on them.
          </li>
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">1 · CHOOSE THE INVOCATION NAME</p>
        <h2>Make Alexa hear the skill, not a radio catalogue.</h2>
        <p>
          The invocation name is what Alexa uses to route a voice command to your custom
          skill. It is not the station name and it is not the stream URL. Use a distinctive,
          easy-to-pronounce two- or three-word name such as{' '}
          <code className="bs-code-inline">subwave controller</code> or{' '}
          <code className="bs-code-inline">subwave live player</code>.
        </p>
        <ul className="bs-list">
          <li>Use lowercase words separated by spaces. Spell numbers out.</li>
          <li>Prefer two or more specific words; avoid a generic one-word name.</li>
          <li>Do not include <code className="bs-code-inline">Alexa</code>,{' '}
            <code className="bs-code-inline">Amazon</code>, <code className="bs-code-inline">Echo</code>,{' '}
            <code className="bs-code-inline">skill</code>, or <code className="bs-code-inline">app</code>.</li>
          <li>Do not include launch words such as <code className="bs-code-inline">open</code>,{' '}
            <code className="bs-code-inline">start</code>, or <code className="bs-code-inline">launch</code>,
            or connecting words such as <code className="bs-code-inline">from</code> and{' '}
            <code className="bs-code-inline">to</code>.</li>
          <li>Do not use a name that sounds like a built-in Alexa command or a well-known radio service.</li>
        </ul>
        <div className="bs-callout">
          <div className="bs-eyebrow">THE TUNEIN FAILURE WE SAW</div>
          <p>
            Phrases such as <code className="bs-code-inline">open chill zone</code>,{' '}
            <code className="bs-code-inline">play subwave radio</code>, or{' '}
            <code className="bs-code-inline">open subwave signal</code> can be interpreted as
            a name-free music request. Alexa may then answer with a station such as “ZBVI from
            TuneIn” without invoking your skill. A distinctive invocation name plus the exact
            phrase <code className="bs-code-inline">Alexa, open &lt;invocation name&gt;</code>{' '}
            forces the custom-skill route much more reliably.
          </p>
        </div>
        <p className="text-muted">
          The station name can still be <strong>CHILL ZONE</strong>. Keep that name in Station
          settings, but use a separate invocation such as{' '}
          <code className="bs-code-inline">subwave controller</code> to open the skill.
        </p>
        <p>
          See Amazon's{' '}
          <a
            href="https://developer.amazon.com/en-US/docs/alexa/interaction-model-design/design-the-invocation-name-for-your-skill.html"
            className="bs-link"
            target="_blank"
            rel="noreferrer"
          >
            invocation-name requirements ↗
          </a>{' '}
          for the current marketplace rules.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">2 · BUILD THE CUSTOM SKILL</p>
        <h2>Use the Alexa Developer Console.</h2>
        <ol className="bs-list">
          <li>Create a <strong>Custom</strong> Alexa skill and choose the locale you will test, such as English (US).</li>
          <li>Set the invocation name to the distinctive name you chose above.</li>
          <li>Keep the model intents and sample utterances focused on playback: start, play, pause, resume, stop, and help.</li>
          <li>Intent names must contain only letters and underscores, such as{' '}
            <code className="bs-code-inline">StartRadioIntent</code> and{' '}
            <code className="bs-code-inline">PlayRadioIntent</code>. Built-in intents keep the{' '}
            <code className="bs-code-inline">AMAZON.</code> prefix, such as{' '}
            <code className="bs-code-inline">AMAZON.StopIntent</code>.</li>
          <li>Save and build the interaction model after changing the invocation name or utterances.</li>
        </ol>
        <p>
          Do not put the invocation name into the custom intent utterances. Alexa supplies the
          invocation phrase separately; the utterance should describe the action, for example
          <code className="bs-code-inline">start the radio</code> or{' '}
          <code className="bs-code-inline">play the station</code>.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">3 · CONFIGURE THE ENDPOINT</p>
        <h2>Use the exact HTTPS webhook URL.</h2>
        <p>
          In the skill's <strong>Build → Endpoint</strong> page, choose <strong>HTTPS</strong> and
          put this in <strong>Default Region</strong>:
        </p>
        <CodeBlock>{`https://your-station.example/api/alexa`}</CodeBlock>
        <p>
          Select <strong>My development endpoint has a certificate from a trusted certificate
          authority</strong>. Leave the optional regional endpoint fields empty unless you have
          deliberately deployed separate regional webhook URLs.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">THE CERTIFICATE FIX</div>
          <p>
            The endpoint failed when Alexa could not trust or reach the TLS certificate. The
            working setup used the public hostname, HTTPS on port 443, and a certificate from
            a public trusted certificate authority. Do not use a self-signed certificate for a
            published skill. Also make sure the certificate's hostname includes the exact
            <code className="bs-code-inline">SITE_URL</code> hostname and that the full chain is
            served by the tunnel or reverse proxy.
          </p>
        </div>
        <p>
          Opening <code className="bs-code-inline">/api/alexa</code> in a browser sends a GET
          request. The skill webhook accepts Alexa's POST request, so a browser response such
          as <code className="bs-code-inline">Cannot GET /alexa</code> does not prove the
          endpoint is broken. Use the SUB/WAVE connection test or the Alexa console's test
          request instead.
        </p>
        <p>
          Amazon's{' '}
          <a
            href="https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-a-web-service.html"
            className="bs-link"
            target="_blank"
            rel="noreferrer"
          >
            web-service endpoint and SSL requirements ↗
          </a>{' '}
          are the authority for certificate and hosting rules.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">4 · CONNECT SUB/WAVE</p>
        <h2>Finish in Connect → Alexa.</h2>
        <ol className="bs-list">
          <li>Open the admin console and go to <strong>Connect → Alexa</strong>.</li>
          <li>Copy the <strong>Alexa webhook endpoint</strong> into the Alexa Developer Console.</li>
          <li>Choose an enabled stream mount. Select <strong>MP3</strong> first when testing an Echo device.</li>
          <li>Choose the <strong>Alexa signed-stream lifetime</strong> when listener authentication is enabled. Use the shortest lifetime that fits your listening pattern.</li>
          <li>Turn on <strong>Enable direct skill</strong>.</li>
          <li>Paste the skill's complete Skill ID into <strong>Alexa Skill ID</strong>.</li>
          <li>Click <strong>Test connection</strong>. Save is enabled only after the current draft passes the test.</li>
          <li>Click <strong>Save advanced skill</strong> after the test passes.</li>
        </ol>
        <p>
          The connection test uses the unsaved values currently in the form. It checks the
          public HTTPS origin, listener access, selected stream response, and webhook
          reachability. It intentionally sends an unsigned probe; a healthy Alexa webhook
          should reject that probe with signature-validation HTTP 400. That proves the route is
          public and protected without pretending SUB/WAVE can forge an Alexa signature.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">FIND THE SKILL ID</p>
        <h2>Copy it from the Alexa console URL.</h2>
        <p>
          The Skill ID is not the display name and not the invocation name. In the Alexa
          Developer Console, open the skill's <strong>Test</strong> page and look at the URL. It
          has this shape. The values below are fictional examples; do not copy them into your
          SUB/WAVE settings:
        </p>
        <CodeBlock>{`https://developer.amazon.com/alexa/console/ask/test/amzn1.ask.skill.12345678-1234-1234-1234-123456789abc/development/en_US`}</CodeBlock>
        <p>
          Copy the complete segment between <code className="bs-code-inline">/test/</code> and{' '}
          <code className="bs-code-inline">/development</code>:
        </p>
        <CodeBlock>{`amzn1.ask.skill.12345678-1234-1234-1234-123456789abc`}</CodeBlock>
        <p className="text-muted">
          The SUB/WAVE field checks that the value has the expected{' '}
          <code className="bs-code-inline">amzn1.ask.skill.&lt;uuid&gt;</code> shape. A syntactically
          valid but different Skill ID cannot be proven to belong to your Alexa account by a
          local HTTP probe; only Alexa's signed request can establish that association. Copy the
          ID from the same skill whose endpoint you configured.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">5 · TEST IN DEVELOPMENT MODE</p>
        <h2>Use your own account and test device.</h2>
        <ol className="bs-list">
          <li>In the Alexa console, set skill testing to <strong>Development</strong>.</li>
          <li>Save and build the model, then refresh the Test page and keep the correct locale selected.</li>
          <li>On your Alexa account, enable the development skill from the Alexa app's developer/test skills area.</li>
          <li>Test the complete phrase: <code className="bs-code-inline">Alexa, open subwave controller</code>.</li>
          <li>After the skill opens, test <code className="bs-code-inline">start the radio</code>,{' '}
            <code className="bs-code-inline">pause</code>, <code className="bs-code-inline">resume</code>, and{' '}
            <code className="bs-code-inline">stop</code>.</li>
        </ol>
        <p>
          Development skills are not public catalogue listings. They are normally available to
          the developer account and its configured test devices. Publishing is a separate Alexa
          certification and distribution process; it does not turn the station name into a
          globally indexed radio station.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">TROUBLESHOOTING</p>
        <h2>What the symptoms mean.</h2>
        <table className="bs-doc-table">
          <thead>
            <tr>
              <th>Symptom</th>
              <th>Check this first</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>“ZBVI from TuneIn” or another catalogue station</td>
              <td>Alexa did not route the phrase to the custom skill. Use the exact distinctive invocation name with <code className="bs-code-inline">open</code>; do not say <code className="bs-code-inline">play &lt;station name&gt;</code> as the first command.</td>
            </tr>
            <tr>
              <td>“Unable to reach the requested skill”</td>
              <td>Check the exact <code className="bs-code-inline">/api/alexa</code> path, public DNS, trusted certificate chain, port 443, and that no proxy login, WAF challenge, or tunnel access page is in front of the webhook.</td>
            </tr>
            <tr>
              <td>Browser says “Cannot GET /alexa”</td>
              <td>That is a GET request to a POST-only webhook. Run the connection test or send an Alexa-shaped POST instead.</td>
            </tr>
            <tr>
              <td>Alexa speaks the confirmation but no music plays</td>
              <td>Select MP3, make sure the stream is online, and check the Alexa device log for <code className="bs-code-inline">AudioPlayer.PlaybackFailed</code>. If listener authentication is enabled, test that the station password is configured and that the signed URL is not being stripped or cached by a proxy. An <code className="bs-code-inline">AudioPlayer.Play</code> event means Alexa received the playback directive; it does not guarantee the device accepted the codec.</td>
            </tr>
            <tr>
              <td>Protected station returns HTTP 401 or reconnects fail</td>
              <td>Keep listener authentication enabled but verify that the selected mount is enabled, the station password is present, the Alexa token lifetime is not already expired, and the reverse proxy forwards the complete <code className="bs-code-inline">?auth=</code> query string to Icecast.</td>
            </tr>
            <tr>
              <td>Unexpected <code className="bs-code-inline">application/ogg</code></td>
              <td>That is the normal container type for Ogg Opus and Ogg FLAC. The SUB/WAVE probe accepts it as reachable audio, but MP3 is the reliable Alexa choice because Ogg is not in Alexa's standard long-form format list.</td>
            </tr>
            <tr>
              <td>Invocation works in the console but not on an Echo</td>
              <td>Confirm the skill is enabled in Development for the same Amazon account, the Echo is on that account, the locale/model was rebuilt, and you are saying the invocation name rather than the dynamic station name.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PRIVACY AND OWNERSHIP</p>
        <h2>This endpoint belongs to your skill.</h2>
        <p>
          In this advanced setup, SUB/WAVE does not register your station in a shared broker or
          Alexa's public radio catalogue. Your skill points to your deployment, and your
          deployment returns its own station stream. Other people cannot use that skill merely
          because they know your stream URL; they would need access to the Alexa skill and its
          invocation. Keep the Alexa account and deployment admin credentials private.
        </p>
        <p>
          A shared public experience would be a different product: one published skill would
          need its own station directory, account or pairing model, and a way to choose which
          station each listener may access. This page documents the simpler station-owner path.
        </p>
        <p>
          Return to the in-product setup at{' '}
          <Link href="/admin/connect?tab=alexa" className="bs-link">Connect → Alexa ↗</Link>.
        </p>
      </section>
    </ManualPage>
  );
}

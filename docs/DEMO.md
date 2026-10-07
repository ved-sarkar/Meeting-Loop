# Synthetic demo walkthrough

The built-in example is a fictional design-review meeting with Alex and Maya. It is created locally when you choose **Explore an example**; it is not an imported recording or a real conversation.

## Review without capture or model inference

1. Build and start the desktop app using the README instructions.
2. Choose **Explore an example**. Open **Design review · sample meeting**.
3. Add a short fictional note in **Personal meeting notes**.
4. Open **Transcript**, inspect its evidence, then return to **Notes**. Your note should remain unchanged.
5. Open **Action items**. Inspect the two proposed actions. **Approve local draft** authorizes local draft work; it does not send anything.
6. Explore **Overview**, local search, **Settings & connections**, appearance, and the floating copilot. Avoid the optional connection-check control if you want no external metadata request.

The example can be browsed without model weights. Generating notes or answers and creating drafts requires running local models. No real meeting or microphone permission is needed to inspect the example.

## Optional full local workflow

After separately provisioning the documented runtimes and models, `npm run test:workflow` uses a temporary synthetic vault to exercise notes, task deduplication, approved drafts, artifact integrity and a next-meeting answer. It does not test microphone/system capture or send messages. Generated output still needs human quality review.

## Screenshot and evidence policy

`npm run test:ui` uses a temporary vault and isolated Electron profile. On success it captures only synthetic screens under `docs/screenshots/` and writes a smoke-test report. Those generated files are ignored by Git and require visual/privacy review before being added deliberately.

The current release preparation could not launch Electron in its restricted execution environment, so this source release does not include freshly verified UI screenshots. Historical screenshots and personal desktop images are excluded. This walkthrough describes the implemented demo and test harness; it is not a claim that the current browser/UI smoke passed.

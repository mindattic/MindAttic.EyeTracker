# Gaze and deception: what eye movement can and cannot tell

Short version: **looking up or away is a well-supported sign of someone thinking. It is not a sign of
lying, and no gaze-based lie detector exists.** MindAttic.Webcam reports where a person looked and
for how long; it never says why, and it never infers emotion or deception. This note is the evidence
and the legal ground behind that choice, and a map from each rule to the module that keeps it.

## 1. What the research says

### "Eye-accessing cues" do not work

The popular idea that eyes moving up-right mean a person is constructing a lie, and up-left that they
are remembering, comes from Neuro-Linguistic Programming (NLP). It has been tested directly. Wiseman,
Watt, ten Brinke, Porter, Couper and Rankin (2012, *PLoS ONE*, "The eyes don't have it: lie detection
and Neuro-Linguistic Programming") recorded people lying and telling the truth and found **no
relationship** between eye direction and lying, and people trained in the NLP cues were no better at
spotting lies than people who were not. Earlier reviews of the NLP representational-systems claims
reached the same conclusion. Nothing in this library treats the direction of a look (left, right, up,
down) as meaningful beyond "that is where the person looked".

### Gaze aversion is about cognitive load

What is well supported is the opposite of a lie signal. People look away from faces and screens when
a question is hard, because the visual scene competes with thinking:

- Glenberg, Schroeder and Robertson (1998, *Memory & Cognition*): averting the gaze (looking away
  from a face, or closing the eyes) **helps** people retrieve and reason, because it disengages from
  the environment.
- Doherty-Sneddon and Phelps (2005, *Memory & Cognition*) and related work with children: gaze
  aversion rises with question difficulty, and children who were allowed to look away gave *better*
  answers.

So a student who looks up, aside or down for a moment before answering is probably doing what an
exam wants them to do. A system that counted that against them would be penalising thinking.

### Deception cues are weak in general

Across many studies, human and automated judgments of deception from non-verbal behaviour sit only a
little above chance (Bond and DePaulo, 2006, meta-analysis, about 54 percent accuracy; DePaulo et al.,
2003, on the weakness of individual cues). Gaze is among the least diagnostic of those cues. There is
no reason to expect a webcam model to do better than people do.

### Pupils: real signal, not available on a webcam

Pupil dilation does track cognitive effort (Kahneman and Beatty, 1966; Beatty, 1982), but the effect
is a fraction of a millimetre against swings of several millimetres from room light and screen
brightness. A consumer webcam shows the iris at roughly 10 to 25 pixels across, with autoexposure
changing the image continuously. **The library does not measure pupil size**, and nothing it reports
should be read as cognitive load, effort, stress or emotion.

### What a webcam can usefully show

Behaviours a human reviewer could confirm from the same video, in a setting where the rules say they
matter:

| Signal | What it is | Module |
| --- | --- | --- |
| No face in view | The person left, or covered the camera | presence |
| A second face | Someone else is in the frame | presence |
| A different-looking face | Geometry differs from the start; weak, a prompt to look | presence |
| A long look off-screen | Time spent looking toward one side, up or down | headpose |
| Reading sweeps toward one off-screen region | Slow sweep along a line then a quick jump back, repeated, toward one region | integrity (reading detector) |
| Poor lighting or framing | Setup problems that make the above unreliable | presence (quality, for the student) |

The reading-pattern signal rests on how reading moves the eyes: a slow, steady sweep along a line
(small saccades and fixations blur into one drift at webcam frame rates) and a quick return sweep to
the start of the next line. Repeated, consistent sweeps toward one place are very different from a
person thinking, which produces irregular, single looks. It is still a signal, not a verdict: someone
may be reading a permitted note, or their own second monitor for an open-book exam.

## 2. Limits of what these modules measure

- **Accuracy.** Gaze region comes from head direction plus iris position in the eye opening, with no
  per-person calibration. Expect errors of several degrees and bad behaviour with glasses glare,
  heavy head turns, low light, or a camera far off the screen axis. It is a left/right/up/down/on-screen
  classifier, not a gaze point. The `eyetracking` module is the one that gives a screen point, after
  calibration, and is still only good to a few percent of the screen.
- **Baseline.** "On-screen" is learned from the first seconds, on the assumption that a person starts
  by looking at the screen. If they did not, the baseline is wrong until `recalibrate()` is called.
  Pass the real screen size to `regionLimitsFor()` for large monitors.
- **Identity.** The same-person check compares landmark geometry, which is far less discriminating
  than a face-recognition model, by design. It will miss a similar-looking person and can flag the
  same person under a big pose, lighting or glasses change. It is a prompt for a human to look.
- **Confidence** in an event is how sure the detector is of *what it saw*, not how likely it is that
  anyone did anything wrong.

## 3. The rules the modules follow

1. **Brief looks away are annotated as thinking.** Off-screen for less than four seconds produces a
   `thinking-glance` annotation, and never an integrity flag. Longer looks are reported as
   `gaze-off-screen` with low confidence and a summary that lists thinking and reading as normal
   explanations. (headpose)
2. **No emotion, stress, attention or deception inference, anywhere.** There is no such model, field
   or event type in the library. Adding one would be a breaking change to this note first.
3. **Annotations never score.** `toHubEvent` caps annotation confidence at 0.3, so an exam server that
   derives severity from confidence records them as information.
4. **Nothing is proof.** The stream is evidence for a person to review, with a sentence on each event
   that says what the eyes did. No module fails, blocks or penalises anyone. The exam platform must keep
   a human in the loop for any consequence.
5. **No frames leave the device.** Modules receive landmark numbers in memory. The one pixel read is a
   16x9 thumbnail averaged to a single brightness number for the lighting warning. Events are reduced by
   `sanitizeEvent` to `type`, `start`, `end`, `confidence` and `summary`, with bounded text, and cannot
   carry images or landmarks. The same-person signature has no export method and is never stored.
   `IntegrityMonitor.privacy` states the contract in code.
6. **Consent first.** Run the monitors only after the person has been told what is watched, why, and
   how long events are kept, and has agreed.

## 4. The law, in outline

This is a plain-language outline for engineers, not legal advice; check the actual deployment.

- **EU AI Act, Article 5(1)(f)** prohibits AI systems that infer emotions of people in education
  institutions (except for medical or safety reasons). Anything that read stress, anxiety or
  "nervousness" from a student's face or eyes would be on the wrong side of that line. Inferring
  deception from the face is the same kind of inference. The library does neither.
- **EU AI Act, Annex III** lists AI used to monitor and detect prohibited behaviour of students
  during tests as **high-risk**. A deployment using the integrity stream in the EU needs the
  obligations that come with high-risk systems (risk management, data governance, human oversight,
  logging, transparency to the people monitored). The library supports oversight by design: the
  output is explained events for a human, not a decision.
- **Illinois BIPA (740 ILCS 14)** treats scans of face geometry as biometric identifiers: written
  notice and a written release before collection, a published retention and destruction schedule, and
  no sale or profit. Landmark geometry used for the same-person check is plausibly in scope even
  though it stays in memory, so the check should be gated behind that consent. Texas and Washington
  have similar statutes.
- **GDPR, Article 9** treats biometric data used to identify a person as special-category data, with
  explicit consent or another narrow basis needed. Because the signature is held only in memory and
  never stored or transmitted, exposure is small, but it is not zero. Do the data-protection impact
  assessment.
- **FERPA** (US education records): events attached to a student's exam session are education
  records. Treat them accordingly (access control, retention, review rights).

## 5. How to use it responsibly

- Show the student a **system check** (camera on, face found, lighting good) before the exam, and tell
  them what the monitors look for.
- Show a reviewer the **event and its sentence**, and the answer given at the same time, not a score.
- Keep `includeQuality` off in the stream (those events are for the student) and `includeAnnotations`
  on, so a reviewer can see that glances were noticed and judged normal.
- Prefer designs that make the behaviour unnecessary (spoken, adaptive questioning that a lookup cannot
  answer) over designs that depend on catching it.

## Sources

- Wiseman, R., Watt, C., ten Brinke, L., Porter, S., Couper, S.-L., and Rankin, C. (2012). The eyes
  don't have it: lie detection and Neuro-Linguistic Programming. *PLoS ONE* 7(7): e40259.
- Glenberg, A. M., Schroeder, J. L., and Robertson, D. A. (1998). Averting the gaze disengages the
  environment and facilitates remembering. *Memory & Cognition* 26, 651-658.
- Doherty-Sneddon, G., and Phelps, F. G. (2005). Gaze aversion: a response to cognitive or social
  difficulty? *Memory & Cognition* 33, 727-733.
- Bond, C. F., and DePaulo, B. M. (2006). Accuracy of deception judgments. *Personality and Social
  Psychology Review* 10, 214-234.
- DePaulo, B. M., et al. (2003). Cues to deception. *Psychological Bulletin* 129, 74-118.
- Kahneman, D., and Beatty, J. (1966). Pupil diameter and load on memory. *Science* 154, 1583-1585.
- Beatty, J. (1982). Task-evoked pupillary responses, processing load, and the structure of processing
  resources. *Psychological Bulletin* 91, 276-292.
- Regulation (EU) 2024/1689 (the AI Act), Article 5(1)(f) and Annex III point 3.
- Illinois Biometric Information Privacy Act, 740 ILCS 14.
- Gadfly, `docs/SOCRATIC_PLATFORM.md` ("Eye movement") and `docs/MASTER-PLAN.md` Part 15.4.

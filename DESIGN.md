---
name: Infinite AI Layer
description: A model transit control surface for routing conversations across AI providers.
colors:
  midnight-enamel: "#07162d"
  deep-platform: "#0b1f3a"
  porcelain: "#f6f3ea"
  muted-porcelain: "#b9c4d2"
  seam: "#314765"
  scarlet: "#f04444"
  cobalt: "#4778ff"
  amber: "#ffbd38"
  route-green: "#46b86d"
typography:
  display:
    fontFamily: "Aptos Narrow, Bahnschrift Condensed, Helvetica Neue, sans-serif"
    fontSize: "clamp(1.75rem, 4vw, 3.5rem)"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Aptos, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Aptos Narrow, Bahnschrift Condensed, Helvetica Neue, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.08em"
rounded:
  stop: "999px"
  control: "8px"
  panel: "12px"
spacing:
  unit: "8px"
  platform: "16px"
  junction: "24px"
components:
  button-primary:
    backgroundColor: "{colors.scarlet}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.control}"
    padding: "12px 18px"
  input:
    backgroundColor: "{colors.deep-platform}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.control}"
    padding: "12px 14px"
---

# Design System: Infinite AI Layer

## Overview

**Creative North Star: “Model Transit Control”**

The interface behaves like a metropolitan route diagram rendered in midnight enamel. Provider connections are lines, models are stops, and the selected connection becomes the bright corridor through the workspace. The system avoids generic floating dashboard cards: hierarchy comes from route color, porcelain seams, aligned labels, and clear interchange points.

**Key Characteristics:**

- Midnight enamel working ground with porcelain text.
- Four route colors reserved for provider identity and operational state.
- Dense, fixed navigation paired with a generous conversation platform.
- Hairline seams and clipped transit geometry instead of decorative shadows.
- Motion follows a route once during streaming; controls remain still and predictable.

## Colors

The palette is dark because the proof app is a long-session developer tool typically used beside editors and terminals. Porcelain text prevents the surface from becoming a neon console.

- **Midnight Enamel** (`#07162d`): application ground.
- **Deep Platform** (`#0b1f3a`): navigation, composer, and inset work surfaces.
- **Porcelain** (`#f6f3ea`): primary text and active stops.
- **Muted Porcelain** (`#b9c4d2`): secondary text.
- **Seam Blue** (`#314765`): divisions and inactive routes.
- **Scarlet / Cobalt / Amber / Route Green:** connection identity and explicit state.

**The Route Ink Rule.** Route colors identify connections and state; they never decorate prose or large empty regions.

## Typography

Narrow humanist headings echo transit signage without turning technical content into terminal cosplay. Body copy uses a durable system UI stack. Monospace is limited to model IDs, tokens, cost, and errors.

- **Display:** condensed, heavy, compact route titles.
- **Title:** semibold UI headings.
- **Body:** 15–16px with 1.5–1.6 line height and a 72ch maximum measure.
- **Label:** narrow, uppercase only for short operational labels.

## Layout

Desktop uses a 280px conversation rail and one flexible workspace. The workspace header, message platform, and composer align on one central track. Configuration reuses the workspace rather than opening a modal. Below 780px, the rail becomes a drawer and the active corridor occupies the full screen.

Spacing uses an 8px base. Tight controls group at 8–12px; route junctions and major regions separate by 24–32px.

## Elevation & Depth

The system is flat at rest. Depth comes from one-step tonal layering and porcelain/seam lines. A soft offset shadow is allowed only for the mobile drawer and focused popovers.

## Shapes

Stations are circles and interchanges are double rings. Controls use clipped or lightly chamfered 8px corners. Content surfaces use 12px corners only when they need enclosure. Pills are restricted to compact status and provider labels.

## Components

### Buttons

Primary buttons carry the active route color. Secondary buttons are transparent with a porcelain seam. Focus creates a two-ring interchange marker. Destructive buttons remain isolated from routine actions.

### Messages

Messages sit directly on the conversation platform, not inside identical cards. A small route node and vertical segment provide provenance. User and assistant roles differ through alignment, surface tone, and label—not cartoon bubbles.

### Inputs

Inputs use deep-platform fill with a seam border. Focus brightens the selected connection color and never relies on color alone. Errors state both the issue and recovery.

### Navigation

The conversation list is a vertical route: each chat is a stop, the active chat is a double-ring interchange, and settings is a terminus separated from conversation history.

## Do's and Don'ts

### Do:

- **Do** use route color to connect provider selection, stream state, and message provenance.
- **Do** keep operational status visible without opening a modal.
- **Do** keep the composer stable while content streams.
- **Do** collapse the route rail by priority on narrow screens.

### Don't:

- **Don't** wrap every message, setting, or metric in a floating card.
- **Don't** use glow, gradients, or monospace as generic AI decoration.
- **Don't** hide connection failures behind a spinner.
- **Don't** shrink the entire desktop layout into an unreadable mobile miniature.

fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## Android

### android deploy

```sh
[bundle exec] fastlane android deploy
```



### android promote_to_open_testing

```sh
[bundle exec] fastlane android promote_to_open_testing
```

Push current AAB to Open Testing (beta) track. Pre-req: Play Console > Testing > Open testing must be enabled for this app.

### android internal

```sh
[bundle exec] fastlane android internal
```

Push current AAB to Internal Testing. Use this for fast iteration with named testers (Warren / BAU beta). Testers must be added once via Play Console; subsequent updates auto-deliver.

### android closed_testing

```sh
[bundle exec] fastlane android closed_testing
```

Push current AAB to Closed Testing (alpha track). Use this when an Open Testing release is still 'In review' but you need a specific tester to get the build now — closed test review is materially faster than the first-time Open Testing review.

### android voice_internal

```sh
[bundle exec] fastlane android voice_internal
```

Push the voice-flavor AAB to Internal Testing on com.listenai.voice.

### android voice_closed_testing

```sh
[bundle exec] fastlane android voice_closed_testing
```

Push the voice-flavor AAB to Closed Testing (alpha) on com.listenai.voice.

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).

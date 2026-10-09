Make sure to implement these using double-loop-tdd (look it up if needed). Test first, pay special attention to refactor step even if you would ignore it.

BUGS

- [ ] Play from beginning button when I open a video player, does not actually starts play from beginning but instead starts from last recorded location.
- [ ] Clicking on the modal side (this TV has magic remote with a pointer) should remove modal with no action taken.
- [ ] Player progress bar is not visible.
- [ ] In a video that has no subtitles, like videos in Armin folder, subtitles modal contains a list of several English and German subtitles which are not actually real.
- [ ] Once I click on my name in upper right corner, enter "Account" view, and go back, using back button, I am unable to open "Account" view again.
- [ ] Back button is not working for "Auth", "Sign in with code" and "Paste a token". Could be history related as we did not work on these since implementation.
- [ ] Speaking of Auth pages, I would prefer a little bit more spaced design for these pages. Maybe 2 column layout with logo and copy on one side and controls on another.


NEW FEATURES

- [ ] Config page allowing to:
    - [ ] select default video option,
    - [ ] select preferred language for audio stream and preferred language for subtitles
    - [ ] configure subtitle display options
- [ ] This also asks that player is then configured to respect these configured choices.

TO BE EXPLORED EVENTUALLY

- [ ] Packaging with `pnpm package` should be fixed as I feel it packages everything.
- [ ] Deploying with `pnpm deploy:tv`, executing remote ssh is not done well.
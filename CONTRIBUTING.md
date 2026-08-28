# Contributing to GitHubBatches

First off, thank you for considering contributing to GitHubBatches! It's people like you that make GitHubBatches such a great tool for developers around the world.

## Where do I go from here?

If you've noticed a bug or have a feature request, make one! It's generally best if you get confirmation of your bug or approval for your feature request this way before starting to code.

## Fork & create a branch

If this is something you think you can fix, then fork GitHubBatches and create a branch with a descriptive name.

A good branch name would be (where issue #325 is the ticket you're working on):

```
git checkout -b 325-add-dark-mode
```

## Get the test suite running

Make sure you're using the latest versions of Node and npm. Install the dependencies:
```
npm install
```

## Implement your fix or feature

At this point, you're ready to make your changes! Feel free to ask for help; everyone is a beginner at first.

## Make a Pull Request

At this point, you should switch back to your master branch and make sure it's up to date with GitHubBatches's master branch:

```
git remote add upstream https://github.com/SIMARSINGHRAYAT/APP_Commit.git
git checkout main
git pull upstream main
```

Then update your feature branch from your local copy of master, and push it!

```
git checkout 325-add-dark-mode
git rebase main
git push --set-upstream origin 325-add-dark-mode
```

Finally, go to GitHub and make a Pull Request!

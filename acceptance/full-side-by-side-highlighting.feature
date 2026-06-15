Feature: Full side-by-side diff highlights only true changes
  As a reviewer
  I want side-by-side (full) mode to align unchanged lines
  So I can see complete files without whole-file false highlights and with clear file boundaries

  Scenario: Single-line insertion keeps unchanged lines neutral
    Given the approved base file content is:
      """
      alpha
      beta
      gamma
      delta
      """
    And the selected commit file content is:
      """
      alpha
      inserted
      beta
      gamma
      delta
      """
    When I open Review Diff in side-by-side (full) mode
    Then line "alpha" is shown as unchanged on both sides
    And line "beta" is shown as unchanged on both sides
    And line "gamma" is shown as unchanged on both sides
    And line "delta" is shown as unchanged on both sides
    And line "inserted" is highlighted only on the selected side
    And no unchanged line is highlighted as changed on both sides

  Scenario: Single-line deletion keeps unchanged lines neutral
    Given the approved base file content is:
      """
      one
      two
      three
      """
    And the selected commit file content is:
      """
      one
      three
      """
    When I open Review Diff in side-by-side (full) mode
    Then line "one" is shown as unchanged on both sides
    And line "three" is shown as unchanged on both sides
    And line "two" is highlighted only on the base side
    And no unchanged line is highlighted as changed on both sides

  Scenario: Single-line replacement stays on one visual row
    Given the approved base file content is:
      """
      before
      old signature
      after
      """
    And the selected commit file content is:
      """
      before
      new signature
      after
      """
    When I open Review Diff in side-by-side (full) mode
    Then line "before" is shown as unchanged on both sides
    And line "after" is shown as unchanged on both sides
    And line "old signature" is highlighted on the base side in the same row as line "new signature" on the selected side

  Scenario: Compact side-by-side replacement stays on one visual row
    Given the approved base file content is:
      """
      before
      old signature
      after
      """
    And the selected commit file content is:
      """
      before
      new signature
      after
      """
    When I open Review Diff in side-by-side mode
    Then line "before" is shown as unchanged on both sides
    And line "after" is shown as unchanged on both sides
    And line "old signature" is highlighted on the base side in the same row as line "new signature" on the selected side

  Scenario: Single-click commit selection survives overlapping refreshes
    Given pending commits are visible in the Review Checkpoint tree
    And commit "abc1234" is currently not selected
    When I single-click commit "abc1234"
    And a background refresh started earlier finishes after this selection
    Then commit "abc1234" remains selected in the tree

  Scenario: First click updates diff for selected commit
    Given pending commits are visible in the Review Checkpoint tree
    And commit "def5678" is currently not selected
    And the Review Diff view is open for another commit
    When I single-click commit "def5678"
    Then commit "def5678" becomes selected in the tree
    And the Review Diff view updates to commit "def5678" without a second click

  Scenario: First click moves selected icon immediately
    Given pending commits are visible in the Review Checkpoint tree
    And commit "9876abc" is currently not selected
    When I single-click commit "9876abc"
    Then the selected icon moves to commit "9876abc" immediately

  Scenario: Diff pane opens immediately with spinner while loading
    Given pending commits are visible in the Review Checkpoint tree
    And commit "feed123" is currently not selected
    And the Review Diff pane is closed
    When I single-click commit "feed123"
    Then the Review Diff pane opens immediately
    And a circular loading indicator is shown
    And when diff data is ready the loading indicator is replaced by the diff content

  Scenario: New request cancels in-flight diff load
    Given the Review Diff pane is loading a diff for commit "111aaaa"
    When I click commit "222bbbb" before the first load completes
    And I switch diff mode to "side-by-side"
    Then the in-flight load for commit "111aaaa" is canceled
    And only the latest request is rendered

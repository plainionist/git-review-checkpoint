Feature: Full side-by-side diff highlights only true changes
  As a reviewer
  I want side-by-side (full) mode to align unchanged lines
  So I can see complete files without whole-file false highlights

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

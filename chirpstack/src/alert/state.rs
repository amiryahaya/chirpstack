#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertState {
    Unknown,
    Active,
    Inactive,
}

impl AlertState {
    pub fn from_i16(v: i16) -> Self {
        match v {
            1 => AlertState::Active,
            2 => AlertState::Inactive,
            _ => AlertState::Unknown,
        }
    }

    pub fn to_i16(self) -> i16 {
        match self {
            AlertState::Unknown => 0,
            AlertState::Active => 1,
            AlertState::Inactive => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    None,
    RecordOnly,
    WentInactive,
    Recovered,
}

pub fn evaluate(previous: AlertState, is_inactive: bool) -> (AlertState, Transition) {
    let new_state = if is_inactive {
        AlertState::Inactive
    } else {
        AlertState::Active
    };

    let transition = match (previous, new_state) {
        (AlertState::Unknown, _) => Transition::RecordOnly,
        (AlertState::Active, AlertState::Inactive) => Transition::WentInactive,
        (AlertState::Inactive, AlertState::Active) => Transition::Recovered,
        _ => Transition::None,
    };

    (new_state, transition)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_evaluate() {
        assert_eq!(
            (AlertState::Active, Transition::RecordOnly),
            evaluate(AlertState::Unknown, false)
        );
        assert_eq!(
            (AlertState::Inactive, Transition::RecordOnly),
            evaluate(AlertState::Unknown, true)
        );
        assert_eq!(
            (AlertState::Active, Transition::None),
            evaluate(AlertState::Active, false)
        );
        assert_eq!(
            (AlertState::Inactive, Transition::WentInactive),
            evaluate(AlertState::Active, true)
        );
        assert_eq!(
            (AlertState::Active, Transition::Recovered),
            evaluate(AlertState::Inactive, false)
        );
        assert_eq!(
            (AlertState::Inactive, Transition::None),
            evaluate(AlertState::Inactive, true)
        );
    }

    #[test]
    fn test_state_i16_roundtrip() {
        for s in [AlertState::Unknown, AlertState::Active, AlertState::Inactive] {
            assert_eq!(s, AlertState::from_i16(s.to_i16()));
        }
    }
}
